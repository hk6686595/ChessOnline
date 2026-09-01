using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace XiangqiClient.Services;

/// <summary>
/// 服务器连接：WebSocket 收发 + 自动重连 + 事件分发
/// 所有事件在后台线程回调，UI 需通过 Dispatcher 更新。
/// </summary>
public class ServerConnection
{
    /// <summary>全局 JSON 选项：服务端字段为 camelCase，反序列化时忽略大小写</summary>
    public static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private ClientWebSocket? _ws;
    private CancellationTokenSource _cts = new();
    private bool _manualClose;
    private bool _connecting;

    /// <summary>当前令牌（登录成功后保存）</summary>
    public string Token { get; set; } = "";

    /// <summary>连接状态变化（true=已连接）</summary>
    public event Action<bool>? StatusChanged;

    /// <summary>收到服务端事件（type, payload JsonElement）</summary>
    public event Action<string, JsonElement>? MessageReceived;

    public bool IsConnected => _ws?.State == WebSocketState.Open;

    public string WsUrl { get; private set; } = "ws://127.0.0.1:8080/ws";

    /// <summary>当前连接的 http(s) 服务器地址（规范化后的），用于判断用户是否修改了地址</summary>
    public string TargetHttpUrl { get; private set; } = "http://127.0.0.1:8080";

    /// <summary>
    /// 校验并规范化 http(s) 服务器地址。
    /// 返回 null 表示合法；否则返回用户可读的中文错误提示。
    /// 合法时 out normalized 为规范化地址（自动补全协议、去掉多余路径）。
    /// </summary>
    public static string? ValidateServerUrl(string? input, out string normalized)
    {
        normalized = "";
        if (string.IsNullOrWhiteSpace(input)) return "服务器地址不能为空";

        var s = input.Trim();
        // 允许直接输入 127.0.0.1:8080，自动补全协议
        if (!s.Contains("://")) s = "http://" + s;

        // 端口单独校验，给出明确的"端口不合法"提示（避免 Uri 抛异常导致程序崩溃）
        var portErr = ExtractPortError(s);
        if (portErr != null) return portErr;

        Uri? u;
        try { Uri.TryCreate(s, UriKind.Absolute, out u); }
        catch { u = null; }
        if (u == null) return "服务器地址格式不正确";
        if (u.Scheme != "http" && u.Scheme != "https") return "服务器地址需以 http:// 或 https:// 开头";
        if (string.IsNullOrEmpty(u.Host)) return "服务器地址缺少主机名";
        if (u.Port < 1 || u.Port > 65535) return "端口不合法，请输入 1-65535 之间的数字";

        normalized = $"{u.Scheme}://{u.Authority}";
        return null;
    }

    /// <summary>提取地址中的端口部分并校验（支持 IPv6 如 [::1]:8080）。返回错误提示，null=端口合法或未填写端口。</summary>
    private static string? ExtractPortError(string s)
    {
        // 去掉协议头
        var auth = s;
        var schemeIdx = auth.IndexOf("://", StringComparison.Ordinal);
        if (schemeIdx >= 0) auth = auth[(schemeIdx + 3)..];
        // 去掉路径 / 查询 / 片段
        var end = auth.IndexOfAny(new[] { '/', '?', '#' });
        if (end >= 0) auth = auth[..end];

        string portPart;
        var bracket = auth.LastIndexOf(']');
        if (bracket >= 0)
        {
            // IPv6：[::1]:8080，端口在最后一个 ']' 之后
            var after = auth[(bracket + 1)..];
            if (after.Length == 0) return null;                 // 无端口
            if (after[0] != ':') return null;                   // 不是端口分隔符，交给 Uri 校验
            portPart = after[1..];
        }
        else
        {
            var idx = auth.LastIndexOf(':');
            if (idx < 0) return null;                           // 无端口
            portPart = auth[(idx + 1)..];
        }

        if (portPart.Length == 0) return "端口不合法，请输入 1-65535 之间的数字";
        if (!int.TryParse(portPart, out var port) || port < 1 || port > 65535)
            return "端口不合法，请输入 1-65535 之间的数字";
        return null;
    }

    /// <summary>
    /// 校验并设置服务器 http 地址。返回 null 表示成功；返回字符串为错误提示（此时保持原地址不变）。
    /// 地址非法时不会抛出异常，避免程序崩溃。
    /// </summary>
    public string? SetServerUrl(string httpUrl)
    {
        var err = ValidateServerUrl(httpUrl, out var normalized);
        if (err != null) return err;
        var u = new Uri(normalized);
        var scheme = u.Scheme == "https" ? "wss" : "ws";
        WsUrl = $"{scheme}://{u.Authority}/ws";
        TargetHttpUrl = normalized;
        return null;
    }

    /// <summary>若连接循环尚未运行则启动它（不阻塞，失败由循环自动重试）</summary>
    public void Connect()
    {
        if (_connecting || IsConnected) return;
        _ = ConnectAsync();
    }

    /// <summary>等待连接成功，最长 timeout；成功返回 true，超时返回 false</summary>
    public async Task<bool> WaitConnectedAsync(TimeSpan timeout)
    {
        if (IsConnected) return true;
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        Action<bool> handler = _ => { if (IsConnected) tcs.TrySetResult(true); };
        StatusChanged += handler;
        try
        {
            if (IsConnected) return true;
            var done = await Task.WhenAny(tcs.Task, Task.Delay(timeout));
            return done == tcs.Task && await tcs.Task;
        }
        finally
        {
            StatusChanged -= handler;
        }
    }

    public async Task ConnectAsync()
    {
        if (_connecting || IsConnected) return;
        // 防御：WsUrl 非法时不要反复重试，直接放弃并报告未连接
        if (!Uri.TryCreate(WsUrl, UriKind.Absolute, out _))
        {
            StatusChanged?.Invoke(false);
            return;
        }
        _connecting = true;
        _manualClose = false;
        _cts = new CancellationTokenSource();
        while (!_manualClose)
        {
            try
            {
                var ws = new ClientWebSocket();
                ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                // 连接超时：10 秒内未建立连接则视为失败重试
                using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
                timeoutCts.CancelAfter(TimeSpan.FromSeconds(10));
                await ws.ConnectAsync(new Uri(WsUrl), timeoutCts.Token);
                _ws = ws;
                _connecting = false;
                StatusChanged?.Invoke(true);
                _ = ReceiveLoopAsync(ws, _cts.Token);
                return;
            }
            catch (OperationCanceledException) when (_manualClose || _cts.IsCancellationRequested)
            {
                _connecting = false;
                return;
            }
            catch (Exception ex) when (!_manualClose)
            {
                Console.WriteLine($"[conn] 连接失败: {ex.Message}");
                _connecting = false;
                StatusChanged?.Invoke(false);
                try { await Task.Delay(2000, _cts.Token); }
                catch { return; }
                _connecting = true;
            }
        }
    }

    private async Task ReceiveLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        try
        {
            while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var ms = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", ct);
                        return;
                    }
                    ms.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                var json = Encoding.UTF8.GetString(ms.ToArray());
                try
                {
                    using var doc = JsonDocument.Parse(json);
                    var root = doc.RootElement;
                    var type = root.TryGetProperty("type", out var t) ? t.GetString() : "";
                    if (!string.IsNullOrEmpty(type))
                    {
                        MessageReceived?.Invoke(type, root.Clone());
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[conn] 解析消息失败: {ex.Message}");
                }
            }
        }
        catch (OperationCanceledException)
        {
            return;
        }
        catch (Exception ex)
        {
            if (_manualClose) return;
            Console.WriteLine($"[conn] 接收循环退出: {ex.Message}");
        }

        if (_manualClose || ct.IsCancellationRequested) return;
        StatusChanged?.Invoke(false);
        await ReconnectLoopAsync();
    }

    /// <summary>断线后指数退避重连</summary>
    private async Task ReconnectLoopAsync()
    {
        for (int i = 0; i < 5 && !_manualClose; i++)
        {
            await Task.Delay(1000 * (i + 1), CancellationToken.None);
            if (_manualClose) return;
            try
            {
                var ws2 = new ClientWebSocket();
                ws2.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                await ws2.ConnectAsync(new Uri(WsUrl), CancellationToken.None);
                _ws = ws2;
                StatusChanged?.Invoke(true);
                _ = ReceiveLoopAsync(ws2, CancellationToken.None);
                return;
            }
            catch { /* 继续重试 */ }
        }
    }

    /// <summary>发送请求 { type, ...payload }</summary>
    public async Task SendAsync(string type, object? payload = null)
    {
        var dict = new Dictionary<string, object?> { ["type"] = type };
        if (payload != null)
        {
            foreach (var p in payload.GetType().GetProperties())
            {
                dict[ToCamel(p.Name)] = p.GetValue(payload);
            }
        }
        var json = JsonSerializer.Serialize(dict);
        await SendRawAsync(json);
    }

    private static string ToCamel(string name)
        => char.ToLowerInvariant(name[0]) + name[1..];

    public async Task SendRawAsync(string json)
    {
        var ws = _ws;
        if (ws == null || ws.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(json);
        try
        {
            await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[conn] 发送失败: {ex.Message}");
        }
    }

    /// <summary>登录（带令牌）</summary>
    public Task AuthWithTokenAsync(string token)
    {
        Token = token;
        return SendAsync("auth.login", new  { token });
    }

    public void Close()
    {
        _manualClose = true;
        _cts.Cancel();
        try { _ws?.Abort(); } catch { }
        _ws = null;
    }

    /// <summary>断开并重新连接（用于退出登录等场景）</summary>
    public async Task ReconnectAsync()
    {
        Close();
        await Task.Delay(200);
        await ConnectAsync();
    }
}
