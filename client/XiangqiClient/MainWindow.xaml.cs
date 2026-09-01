using System.IO;
using System.Text.Json;
using System.Windows;
using XiangqiClient.Services;
using XiangqiClient.ViewModels;
using XiangqiClient.Views;

namespace XiangqiClient;

public partial class MainWindow : Window
{
    private readonly ServerConnection _conn = new();
    private readonly MainViewModel _vm;//构造函数中才能初始化，因为需要传入 _conn

    private static string ConfigFile =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "XiangqiClient", "config.json");

    public MainWindow()
    {
        InitializeComponent();
        _vm = new MainViewModel(_conn);
        DataContext = _vm;
        Loaded += OnLoaded;
        Closing += OnClosing;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            // 读取本地配置：服务器地址 / 会话令牌 / 记住的账号
            try
            {
                if (File.Exists(ConfigFile))
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(ConfigFile));
                    var root = doc.RootElement;
                    if (root.TryGetProperty("server", out var s)) _vm.ServerUrl = s.GetString() ?? _vm.ServerUrl;
                    if (root.TryGetProperty("token", out var t)) _conn.Token = t.GetString() ?? "";
                    if (root.TryGetProperty("rememberAccount", out var ra)) _vm.RememberAccount = ra.GetBoolean();
                    if (root.TryGetProperty("savedName", out var sn)) _vm.SavedName = sn.GetString() ?? "";
                    if (root.TryGetProperty("savedPassword", out var sp)) _vm.SavedPassword = sp.GetString() ?? "";
                    if (root.TryGetProperty("accountHistory", out var ah) && ah.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in ah.EnumerateArray())
                        {
                            var v = item.GetString();
                            if (!string.IsNullOrEmpty(v)) _vm.AccountHistory.Add(v);
                        }
                    }
                }
            }
            catch { /* 忽略损坏的配置文件 */ }

            // 记住账号：自动填充登录表单
            _vm.LoginName = _vm.SavedName;
            LoginViewControl.RestoreSavedAccount();

            // 校验服务器地址：不合法时给出提示，而不是让 Uri 抛异常崩溃
            var err = ServerConnection.ValidateServerUrl(_vm.ServerUrl, out var normalized);
            if (err != null)
            {
                _vm.FormError = err;
                _vm.StatusText = "服务器地址不合法：" + err;
            }
            else
            {
                _vm.ServerUrl = normalized;
                _conn.SetServerUrl(normalized);
                await _conn.ConnectAsync();
            }
        }
        catch (Exception ex)
        {
            // 兜底：任何启动期异常都不允许让程序崩溃
            _vm.StatusText = "启动时连接失败：" + ex.Message;
        }
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        // 先关掉下拉/Popup，避免 Fade 动画在窗口销毁时抛出 TaskCanceledException
        try { ViewHelpers.CloseComboDropDowns(this); } catch { /* 忽略 */ }
        SoundService.StopBgm();
        try
        {
            // 当前为正式账号且勾选"记住账号"时，更新保存的账号
            if (_vm.User is { IsGuest: false } && _vm.RememberAccount)
            {
                _vm.SavedName = _vm.LoginName;
                _vm.SavedPassword = _vm.LoginPassword;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(ConfigFile)!);
            var payload = new
            {
                server = _vm.ServerUrl,
                token = _conn.Token,
                rememberAccount = _vm.RememberAccount,
                savedName = _vm.SavedName,
                savedPassword = _vm.SavedPassword,
                accountHistory = new System.Collections.Generic.List<string>(_vm.AccountHistory).ToArray(),
            };
            File.WriteAllText(ConfigFile, JsonSerializer.Serialize(payload));
        }
        catch { /* 忽略保存失败 */ }
        _conn.Close();
    }
}
