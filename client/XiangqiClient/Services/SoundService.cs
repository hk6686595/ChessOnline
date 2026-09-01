using System.IO;
using System.Media;
using System.Windows;
using System.Windows.Media;

namespace XiangqiClient.Services;

/// <summary>
/// 音效与背景音乐。
/// 走子/吃子/选子/将军用 SoundPlayer（WAV，与 BGM 互不抢通道）；
/// 背景音乐一律用 MediaPlayer 循环，对局中落子不会打断 BGM。
///
/// 覆盖优先级（exe 同目录优先）：
///   BGM：bgm.mp3 → bgm.wav → 嵌入的录屏提取音频 / 占位曲
/// 音效：move.wav / capture.wav（或 eat.wav）/ check.wav / mate.wav / select.wav
///        / voice-eat.wav（「吃」）/ voice-check.wav（「将军」）/ voice-mate.wav（「绝杀」）→ 嵌入资源
/// </summary>
public static class SoundService
{
    private static readonly SoundPlayer? MoveSound = LoadSfx("move.wav");
    private static readonly SoundPlayer? CaptureSound = LoadSfx("capture.wav", "eat.wav");
    private static readonly SoundPlayer? CheckSound = LoadSfx("check.wav");
    private static readonly SoundPlayer? MateSound = LoadSfx("mate.wav");
    private static readonly SoundPlayer? WinSound = LoadSfx("win.wav");
    private static readonly SoundPlayer? SelectSound = LoadSfx("select.wav");

    private static MediaPlayer? _bgm;
    private static bool _bgmPlaying;
    private static bool _bgmOpening;
    private static bool _wantBgm;

    private static MediaPlayer? _eatVoice;
    private static MediaPlayer? _checkVoice;
    private static MediaPlayer? _mateVoice;
    private static bool _voicesInited;

    public static void PlayMove(bool capture)
    {
        PlayMove(capture, check: false);
    }

    /// <summary>落子：木击 + 可选语音「吃」「将军」。check 与 capture 可同时报。</summary>
    public static void PlayMove(bool capture, bool check)
    {
        EnsureVoices();
        if (check) Play(CheckSound ?? (capture ? CaptureSound : MoveSound) ?? MoveSound);
        else Play(capture ? CaptureSound ?? MoveSound : MoveSound);

        if (capture && check)
        {
            PlayVoice(_eatVoice);
            PlayVoiceLater(_checkVoice, 200);
        }
        else if (check) PlayVoice(_checkVoice);
        else if (capture) PlayVoice(_eatVoice);
    }

    public static void PlayCheck()
    {
        PlayMove(false, check: true);
    }

    /// <summary>象棋绝杀：落子木击 + 语音「绝杀」，不再使用锣鼓音效</summary>
    public static void PlayMate(bool capture = false)
    {
        EnsureVoices();
        Play(capture ? CaptureSound ?? MoveSound : MoveSound);
        PlayVoice(_mateVoice ?? _checkVoice);
    }

    /// <summary>胜利：上行五声音阶号角（仅获胜方本人播放）</summary>
    public static void PlayVictory()
    {
        Play(WinSound ?? MateSound ?? MoveSound);
    }

    public static void PlaySelect()
    {
        EnsureVoices();
        Play(SelectSound);
    }

    /// <summary>进入大厅或房间后循环播放背景音乐（已在播则不重开）</summary>
    public static void StartBgm()
    {
        var app = Application.Current;
        if (app == null) return;
        if (!app.Dispatcher.CheckAccess())
        {
            app.Dispatcher.BeginInvoke(StartBgm);
            return;
        }
        _wantBgm = true;
        if (_bgmPlaying) return;
        EnsureBgm();
        EnsureVoices();
        TryPlayBgm();
    }

    /// <summary>回到登录页或关闭程序时停止背景音乐</summary>
    public static void StopBgm()
    {
        var app = Application.Current;
        if (app == null) return;
        if (!app.Dispatcher.CheckAccess())
        {
            app.Dispatcher.BeginInvoke(StopBgm);
            return;
        }
        _wantBgm = false;
        _bgmPlaying = false;
        try { _bgm?.Stop(); } catch { /* 忽略 */ }
    }

    /// <summary>兼容旧调用名</summary>
    public static void StartLobbyBgm() => StartBgm();
    public static void StopLobbyBgm() => StopBgm();

    private static void Play(SoundPlayer? player)
    {
        if (player == null) return;
        try
        {
            player.Stop();
            player.Play();
        }
        catch { /* 播放失败忽略 */ }
    }

    private static void EnsureVoices()
    {
        if (_voicesInited) return;
        _voicesInited = true;
        _eatVoice = OpenVoice("voice-eat.wav");
        _checkVoice = OpenVoice("voice-check.wav");
        _mateVoice = OpenVoice("voice-mate.wav");
    }

    private static MediaPlayer? OpenVoice(string name)
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, name);
            if (!File.Exists(path)) path = ExtractResourceToTemp(name) ?? "";
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return null;
            var mp = new MediaPlayer { Volume = 1.0 };
            mp.Open(new Uri(path));
            return mp;
        }
        catch { return null; }
    }

    private static void PlayVoice(MediaPlayer? mp)
    {
        if (mp == null) return;
        var app = Application.Current;
        if (app == null) return;
        if (!app.Dispatcher.CheckAccess())
        {
            app.Dispatcher.BeginInvoke(() => PlayVoice(mp));
            return;
        }
        try
        {
            mp.Stop();
            mp.Position = TimeSpan.Zero;
            mp.Play();
        }
        catch { /* 播放失败忽略 */ }
    }

    private static void PlayVoiceLater(MediaPlayer? mp, int delayMs)
    {
        if (mp == null) return;
        var app = Application.Current;
        if (app == null) return;
        void start()
        {
            var t = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(delayMs) };
            t.Tick += (_, _) => { t.Stop(); PlayVoice(mp); };
            t.Start();
        }
        if (app.Dispatcher.CheckAccess()) start();
        else app.Dispatcher.BeginInvoke(start);
    }

    private static void EnsureBgm()
    {
        if (_bgm != null || _bgmOpening) return;
        var dir = AppContext.BaseDirectory;
        foreach (var name in new[] { "bgm.mp3", "bgm.wav" })
        {
            var path = Path.Combine(dir, name);
            if (File.Exists(path) && OpenBgm(new Uri(path))) return;
        }
        foreach (var name in new[] { "bgm.mp3", "bgm.wav" })
        {
            var embedded = ExtractResourceToTemp(name);
            if (embedded != null && OpenBgm(new Uri(embedded))) return;
        }
    }

    private static bool OpenBgm(Uri uri)
    {
        try
        {
            var mp = new MediaPlayer { Volume = 0.46 };
            mp.MediaEnded += (_, _) =>
            {
                try
                {
                    mp.Stop();
                    mp.Position = TimeSpan.Zero;
                    mp.Play();
                }
                catch { /* 忽略 */ }
            };
            mp.MediaFailed += (_, _) =>
            {
                try { mp.Close(); } catch { /* 忽略 */ }
                if (ReferenceEquals(_bgm, mp)) _bgm = null;
                _bgmPlaying = false;
                _bgmOpening = false;
            };
            mp.MediaOpened += (_, _) =>
            {
                _bgmOpening = false;
                if (_wantBgm) TryPlayBgm();
            };
            _bgmOpening = true;
            mp.Open(uri);
            _bgm = mp;
            return true;
        }
        catch
        {
            _bgmOpening = false;
            _bgm = null;
            return false;
        }
    }

    private static void TryPlayBgm()
    {
        if (_bgm == null) return;
        try
        {
            _bgm.Play();
            _bgmPlaying = true;
        }
        catch { _bgmPlaying = false; }
    }

    private static string? ExtractResourceToTemp(string name)
    {
        try
        {
            var src = Application.GetResourceStream(new Uri($"pack://application:,,,/assets/{name}"))?.Stream;
            if (src == null) return null;
            var dest = Path.Combine(Path.GetTempPath(), "BattlePlatform_" + name);
            using (src)
            using (var fs = File.Create(dest))
                src.CopyTo(fs);
            return dest;
        }
        catch { return null; }
    }

    private static SoundPlayer? LoadSfx(params string[] names)
    {
        var dir = AppContext.BaseDirectory;
        foreach (var name in names)
        {
            var path = Path.Combine(dir, name);
            if (!File.Exists(path)) continue;
            try { return new SoundPlayer(path); }
            catch { /* 尝试下一个 */ }
        }
        foreach (var name in names)
        {
            try
            {
                var stream = Application.GetResourceStream(new Uri($"pack://application:,,,/assets/{name}"))?.Stream;
                if (stream != null) return new SoundPlayer(stream);
            }
            catch { /* 尝试下一个 */ }
        }
        return null;
    }
}
