using System.Collections.ObjectModel;
using System.Text.Json;
using System.Windows;
using XiangqiClient.Models;
using XiangqiClient.Services;

namespace XiangqiClient.ViewModels;

public enum ViewMode { Login, Lobby, Room }

/// <summary>主视图模型：持有全部状态并处理服务端消息</summary>
public class MainViewModel : ViewModelBase
{
    private readonly ServerConnection _conn;

    public MainViewModel(ServerConnection conn)
    {
        _conn = conn;
        _conn.MessageReceived += OnMessage;
        _conn.StatusChanged += OnStatusChanged;

        CreateRoomCmd = new RelayCommand(_ => CreateRoom(), _ => CanAction);
        StartAiCmd = new RelayCommand(async _ => { AiPanelOpen = false; await _conn.SendAsync("room.create", new { gameType = SelectedGameType, vsAI = true, aiLevel = SelectedAiLevel }); }, _ => CanAction);
        OpenAiPanelCmd = new RelayCommand(_ => { AiPanelOpen = true; });
        CloseAiPanelCmd = new RelayCommand(_ => { AiPanelOpen = false; });
        QuickJoinCmd = new RelayCommand(async _ => await _conn.SendAsync("room.quickJoin", new { gameType = SelectedGameType }), _ => CanAction);
        // 一键匹配：按积分动态窗口配对（服务端权威），仅不在房间时可发起；匹配中再点一次取消
        MatchCmd = new RelayCommand(_ => ToggleMatch(), _ => Room == null);
        LeaveRoomCmd = new RelayCommand(async _ => await _conn.SendAsync("room.leave"), _ => CanAction);
        ReadyCmd = new RelayCommand(_ => ToggleReady(), _ => CanAction);
        StartCmd = new RelayCommand(async _ => await _conn.SendAsync("room.start"), _ => CanStart);
        SurrenderCmd = new RelayCommand(async _ => await SurrenderConfirmAsync(), _ => InPlayingGame);
        DrawOfferCmd = new RelayCommand(async _ => await DrawOfferConfirmAsync(), _ => CanOfferDraw);
        AgreeDrawCmd = new RelayCommand(async _ => { DrawPromptVisible = false; await _conn.SendAsync("game.drawRespond", new { agree = true }); });
        RejectDrawCmd = new RelayCommand(async _ => { DrawPromptVisible = false; await _conn.SendAsync("game.drawRespond", new { agree = false }); });
        RestartCmd = new RelayCommand(async _ => await _conn.SendAsync("game.restart"), _ => IsOwner && Game?.Over == true);
        SendLobbyChatCmd = new RelayCommand(_ => SendLobbyChat(), _ => !string.IsNullOrWhiteSpace(LobbyChatInput));
        SendRoomChatCmd = new RelayCommand(_ => SendRoomChat(), _ => !string.IsNullOrWhiteSpace(RoomChatInput));
        CellClickCmd = new RelayCommand(p => OnCellClick((Point2)p!), _ => CanAction);
        SwitchModeCommand = new RelayCommand(p => SwitchMode(p is bool b && b));
        UndoCmd = new RelayCommand(async _ => await _conn.SendAsync("game.undoRequest"), _ => InPlayingGame && (Game?.Moves.Count ?? 0) > 0);
        HintCmd = new RelayCommand(async _ => await _conn.SendAsync("game.hint"), _ => MyTurn && !(IsXiangqi && IsBlackView));
        AgreeUndoCmd = new RelayCommand(async _ => { UndoPromptVisible = false; await _conn.SendAsync("game.undoRespond", new { agree = true }); });
        RejectUndoCmd = new RelayCommand(async _ => { UndoPromptVisible = false; await _conn.SendAsync("game.undoRespond", new { agree = false }); });

        AddFriendCmd = new RelayCommand(_ => AddFriend(), _ => !string.IsNullOrWhiteSpace(FriendAddInput));
        AcceptFriendCmd = new RelayCommand(p => AcceptFriend(IdOf(p)), _ => true);
        RejectFriendCmd = new RelayCommand(p => RejectFriend(IdOf(p)), _ => true);
        RemoveFriendCmd = new RelayCommand(p => RemoveFriend(IdOf(p)), _ => true);
        SendInviteCmd = new RelayCommand(_ => SendInviteFromSelection(), _ => CanInvite && SelectedFriend != null);

        OpenPrivateChatCmd = new RelayCommand(p =>
        {
            if (p is FriendInfo fi)
            {
                SelectedFriendChat = fi;
                _unread[fi.Id] = 0; // 打开即视为已读
                fi.UnreadCount = 0;
                OnPropertyChanged(nameof(HasUnreadPrivate));
                OnPropertyChanged(nameof(UnreadPrivateCount));
                RefreshFriendUnread(fi.Id, 0);
            }
        }, _ => true);
        ClosePrivateChatCmd = new RelayCommand(_ => SelectedFriendChat = null, _ => true);
        SendPrivateChatCmd = new RelayCommand(_ => SendPrivateChat(), _ => SelectedFriendChat != null && !string.IsNullOrWhiteSpace(PrivateInput));

        // 头像
        OpenAvatarPanelCmd = new RelayCommand(_ => AvatarPanelOpen = true, _ => true);
        CloseAvatarPanelCmd = new RelayCommand(_ => AvatarPanelOpen = false, _ => true);
        SelectAvatarCmd = new RelayCommand(p => SelectAvatar(p as string), _ => true);

        // 复盘
        ReplayMatchCmd = new RelayCommand(p => RequestReplay(p as MatchRecord), _ => true);
        CloseReplayCmd = new RelayCommand(_ => CloseReplay(), _ => true);
        ReplayPrevCmd = new RelayCommand(_ => ReplayPrev(), _ => CanReplayPrev);
        ReplayNextCmd = new RelayCommand(_ => ReplayNext(), _ => CanReplayNext);
        ReplayFirstCmd = new RelayCommand(_ => ReplayFirst(), _ => CanReplayPrev);
        ReplayLastCmd = new RelayCommand(_ => ReplayLast(), _ => CanReplayNext);

        _turnTimer.Tick += OnTurnTimerTick;
        _turnTimer.Start();
    }

    // ---------------- 视图状态 ----------------

    private ViewMode _currentView = ViewMode.Login;
    public ViewMode CurrentView
    {
        get => _currentView;
        set
        {
            if (Set(ref _currentView, value))
            {
                OnPropertyChanged(nameof(IsLobby));
                OnPropertyChanged(nameof(IsLogin));
                OnPropertyChanged(nameof(IsRoom));
                // 大厅与对局房间都播放背景音乐，仅登录页停止
                if (IsLogin) SoundService.StopBgm();
                else SoundService.StartBgm();
            }
        }
    }
    public bool IsLogin => CurrentView == ViewMode.Login;
    public bool IsLobby => CurrentView == ViewMode.Lobby;
    public bool IsRoom => CurrentView == ViewMode.Room;

    private bool _connected;
    public bool Connected
    {
        get => _connected;
        set { if (Set(ref _connected, value)) OnPropertyChanged(nameof(ConnectText)); }
    }
    public string ConnectText => Connected ? "● 已连接" : "○ 未连接";

    private string _statusText = "欢迎使用对战平台";
    public string StatusText { get => _statusText; set => Set(ref _statusText, value); }

    private string _serverUrl = "http://127.0.0.1:8080";
    public string ServerUrl { get => _serverUrl; set => Set(ref _serverUrl, value); }

    private string _loginName = "";
    public string LoginName { get => _loginName; set => Set(ref _loginName, value); }

    private string _loginPassword = "";
    public string LoginPassword { get => _loginPassword; set => Set(ref _loginPassword, value); }

    // ---------------- 记住登录账号 ----------------

    private bool _rememberAccount = true;
    public bool RememberAccount
    {
        get => _rememberAccount;
        set { if (Set(ref _rememberAccount, value)) OnPropertyChanged(nameof(RememberHint)); }
    }
    public string RememberHint => RememberAccount ? "已记住账号，下次自动填充" : "不保存账号信息";

    private string _savedName = "";
    public string SavedName { get => _savedName; set => Set(ref _savedName, value); }

    private string _savedPassword = "";
    public string SavedPassword { get => _savedPassword; set => Set(ref _savedPassword, value); }

    // ---------------- 历史账号（下拉选择） ----------------
    private readonly System.Collections.ObjectModel.ObservableCollection<string> _accountHistory = new();
    public System.Collections.ObjectModel.ObservableCollection<string> AccountHistory => _accountHistory;

    private void AddAccountHistory(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return;
        for (int i = 0; i < _accountHistory.Count; i++)
        {
            if (_accountHistory[i] == name) { if (i != 0) _accountHistory.Move(i, 0); return; }
        }
        _accountHistory.Insert(0, name);
        while (_accountHistory.Count > 12) _accountHistory.RemoveAt(_accountHistory.Count - 1);
    }

    // ---------------- 注册表单 ----------------

    private bool _registerMode;
    /// <summary>true=注册表单，false=登录表单</summary>
    public bool RegisterMode
    {
        get => _registerMode;
        set
        {
            if (Set(ref _registerMode, value))
            {
                OnPropertyChanged(nameof(IsLoginMode));
                OnPropertyChanged(nameof(FormTitle));
                FormError = "";
            }
        }
    }
    public bool IsLoginMode => !RegisterMode;
    public string FormTitle => RegisterMode ? "创建账号" : "欢迎回来";

    /// <summary>是否显示"填入测试账号"按钮（仅 DEBUG 构建）</summary>
    public bool ShowTestFill
    {
        get
        {
#if DEBUG
            return true;
#else
            return false;
#endif
        }
    }

    /// <summary>填充测试注册账号（供 UI 自动化/演示）</summary>
    public void FillTestRegister()
    {
        RegisterName = $"测试用户{Random.Shared.Next(100, 999)}";
        RegisterPassword = "test1234";
        RegisterConfirm = "test1234";
        FormError = "";
    }

    private string _registerName = "";
    public string RegisterName
    {
        get => _registerName;
        set { if (Set(ref _registerName, value)) ValidateRegister(); }
    }

    private string _registerPassword = "";
    public string RegisterPassword
    {
        get => _registerPassword;
        set { if (Set(ref _registerPassword, value)) ValidateRegister(); }
    }

    private string _registerConfirm = "";
    public string RegisterConfirm
    {
        get => _registerConfirm;
        set { if (Set(ref _registerConfirm, value)) ValidateRegister(); }
    }

    private string _formError = "";
    /// <summary>表单校验/服务端错误提示</summary>
    public string FormError
    {
        get => _formError;
        set { if (Set(ref _formError, value)) OnPropertyChanged(nameof(HasFormError)); }
    }
    public bool HasFormError => !string.IsNullOrEmpty(FormError);

    /// <summary>注册表单是否通过本地校验</summary>
    public bool CanRegister
    {
        get
        {
            return NameValid(RegisterName) && RegisterPassword.Length >= 4
                && RegisterPassword.Length <= 64 && RegisterPassword == RegisterConfirm;
        }
    }

    private static bool NameValid(string? name)
        => !string.IsNullOrEmpty(name) && name.Length >= 2 && name.Length <= 16
           && System.Text.RegularExpressions.Regex.IsMatch(name, @"^[\w\u4e00-\u9fa5-]+$");

    /// <summary>实时校验注册表单并给出提示</summary>
    private void ValidateRegister()
    {
        OnPropertyChanged(nameof(CanRegister));
        if (RegisterName.Length > 0 && !NameValid(RegisterName))
        {
            FormError = "昵称需为 2-16 位中文/字母/数字/下划线/连字符";
            return;
        }
        if (RegisterPassword.Length > 0 && RegisterPassword.Length < 4)
        {
            FormError = "密码长度至少 4 位";
            return;
        }
        if (RegisterConfirm.Length > 0 && RegisterPassword != RegisterConfirm)
        {
            FormError = "两次输入的密码不一致";
            return;
        }
        FormError = "";
    }

    // ---------------- 用户与房间 ----------------

    private UserInfo? _user;
    public UserInfo? User { get => _user; set { if (Set(ref _user, value)) { OnPropertyChanged(nameof(UserBar)); OnPropertyChanged(nameof(IsBlackView)); OnPropertyChanged(nameof(CanConfigureGame)); OnPropertyChanged(nameof(UserAvatar)); } } }
    public string UserBar => User == null ? "" : $"{User.Name}（{User.Rating} 分）胜 {User.Wins} / 负 {User.Losses} / 平 {User.Draws}";

    /// <summary>当前用户头像（emoji）</summary>
    public string UserAvatar => User?.Avatar ?? "🐯";

    /// <summary>可选头像列表（实例属性，供绑定）</summary>
    public string[] AvatarOptions { get; } = new[]
    {
        "🐯","🦁","🐻","🐼","🐨","🦊","🐺","🐶","🐱","🐭","🐹","🐰","🐷","🐸","🐵","🐔",
        "🐧","🦆","🦅","🦉","🦇","🦄","🐝","🦋","🐢","🐙","🦑","🦐","🦀","🐠","🐟","🐬",
        "🐳","🦈","🐊","🦓","🦒","🐘","🦏","🦛","🐪","🐫","🦘","🐃","🐂","🐄","🐎","🐖",
        "🐏","🐑","🦙","🐐","🦌","🐕","🐩","🐈","🐓","🦃","🦚","🦜","🦢","🦩","🕊️","🐇",
        "🦝","🦨","🦡","🦦","🦥","🐁","🐀","🐿️","🦔"
    };

    private bool _avatarPanelOpen;
    /// <summary>头像选择面板是否展开</summary>
    public bool AvatarPanelOpen { get => _avatarPanelOpen; set => Set(ref _avatarPanelOpen, value); }

    private int _selectedRightTab;
    /// <summary>右侧标签页索引：0=排行榜 1=我的战绩 2=大厅聊天</summary>
    public int SelectedRightTab { get => _selectedRightTab; set => Set(ref _selectedRightTab, value); }

    public ObservableCollection<RoomListItem> RoomList { get; } = new();
    public ObservableCollection<RankItem> Rankings { get; } = new();
    public ObservableCollection<ChatMessage> LobbyChats { get; } = new();
    public ObservableCollection<ChatMessage> RoomChats { get; } = new();
    public ObservableCollection<MatchRecord> MyMatches { get; } = new();
    public ObservableCollection<MoveRecord> MoveList { get; } = new();

    private RoomInfo? _room;
    public RoomInfo? Room
    {
        get => _room;
        set
        {
            if (Set(ref _room, value))
            {
                OnPropertyChanged(nameof(RoomTitle));
                OnPropertyChanged(nameof(ReadyButtonText));
                OnPropertyChanged(nameof(CanStart));
                OnPropertyChanged(nameof(IsGomoku));
                OnPropertyChanged(nameof(IsXiangqi));
                OnPropertyChanged(nameof(IsBlackView));
                OnPropertyChanged(nameof(IsPvp));
                OnPropertyChanged(nameof(CanInvite));
                OnPropertyChanged(nameof(CanOfferDraw));
                SyncGameConfigFromRoom();
                System.Windows.Input.CommandManager.InvalidateRequerySuggested();
            }
        }
    }
    public string RoomTitle => Room == null ? "" : $"{Room.Name}  #{Room.Id}  {Room.GameName}";
    /// <summary>当前房间是否为人对人（非人机）模式</summary>
    public bool IsPvp => Room?.Mode == "pvp";

    /// <summary>人对人且对局进行中才可求和（人机不提供求和）</summary>
    public bool CanOfferDraw => InPlayingGame && IsPvp;

    // ---------------- 好友与定向邀请 ----------------

    /// <summary>好友列表（含在线状态）</summary>
    public ObservableCollection<FriendInfo> Friends { get; } = new();

    /// <summary>待我处理的入站好友请求</summary>
    public ObservableCollection<FriendRequestInfo> FriendRequests { get; } = new();

    /// <summary>我发出的、待对方处理的出站好友请求</summary>
    public ObservableCollection<FriendRequestInfo> OutgoingRequests { get; } = new();

    private string _friendAddInput = "";
    /// <summary>加好友输入框（按昵称）</summary>
    public string FriendAddInput
    {
        get => _friendAddInput;
        set => Set(ref _friendAddInput, value);
    }

    /// <summary>是否有待处理的好友请求（用于红点提示）</summary>
    public bool HasFriendRequests => FriendRequests.Count > 0;

    /// <summary>待处理好友请求数量</summary>
    public int FriendRequestCount => FriendRequests.Count;

    /// <summary>当前房间是否可发起邀请（人在 pvp 房间内）</summary>
    public bool CanInvite => IsPvp && Room != null;

    private FriendInfo? _selectedFriend;
    /// <summary>邀请好友时选中的好友</summary>
    public FriendInfo? SelectedFriend
    {
        get => _selectedFriend;
        set
        {
            if (Set(ref _selectedFriend, value))
                System.Windows.Input.CommandManager.InvalidateRequerySuggested();
        }
    }

    // ---------------- 好友私聊 ----------------

    private readonly System.Collections.Generic.Dictionary<string, ObservableCollection<ChatMessage>> _privateChats = new();
    private readonly System.Collections.Generic.Dictionary<string, int> _unread = new();
    /// <summary>保持引用，避免 SoundPlayer 被 GC 回收导致播放中断</summary>
    private System.Media.SoundPlayer? _notifyPlayer;

    /// <summary>是否有未读私聊消息（用于红点提示）</summary>
    public bool HasUnreadPrivate
    {
        get { foreach (var v in _unread.Values) if (v > 0) return true; return false; }
    }
    /// <summary>未读私聊消息总数</summary>
    public int UnreadPrivateCount
    {
        get { int s = 0; foreach (var v in _unread.Values) s += v; return s; }
    }

    private FriendInfo? _selectedFriendChat;
    /// <summary>当前正在私聊的好友（null 表示在好友列表面板）</summary>
    public FriendInfo? SelectedFriendChat
    {
        get => _selectedFriendChat;
        set
        {
            if (Set(ref _selectedFriendChat, value))
            {
                OnPropertyChanged(nameof(IsInPrivateChat));
                OnPropertyChanged(nameof(CurrentPrivateMessages));
                System.Windows.Input.CommandManager.InvalidateRequerySuggested();
            }
        }
    }

    public bool IsInPrivateChat => SelectedFriendChat != null;

    /// <summary>当前私聊窗口的消息列表</summary>
    public ObservableCollection<ChatMessage> CurrentPrivateMessages
    {
        get
        {
            if (_selectedFriendChat == null) return new ObservableCollection<ChatMessage>();
            if (!_privateChats.ContainsKey(_selectedFriendChat.Id))
                _privateChats[_selectedFriendChat.Id] = new ObservableCollection<ChatMessage>();
            return _privateChats[_selectedFriendChat.Id];
        }
    }

    private string _privateInput = "";
    public string PrivateInput
    {
        get => _privateInput;
        set
        {
            if (Set(ref _privateInput, value))
                System.Windows.Input.CommandManager.InvalidateRequerySuggested();
        }
    }

    private bool _matching;
    public bool Matching
    {
        get => _matching;
        set
        {
            if (Set(ref _matching, value))
            {
                OnPropertyChanged(nameof(MatchButtonText));
                OnPropertyChanged(nameof(MatchHintText));
            }
        }
    }
    public string MatchButtonText => Matching ? "取消匹配…" : "⚡ 一键匹配";
    public string MatchHintText => Matching ? "正在匹配与您积分相近的对手，点击按钮可取消…" : "";

    private string _roomNameInput = "";
    public string RoomNameInput { get => _roomNameInput; set => Set(ref _roomNameInput, value); }
    private string _roomPasswordInput = "";
    public string RoomPasswordInput { get => _roomPasswordInput; set => Set(ref _roomPasswordInput, value); }
    private bool _roomPrivateInput;
    public bool RoomPrivateInput { get => _roomPrivateInput; set => Set(ref _roomPrivateInput, value); }

    private string _selectedGameType = "xiangqi";
    public string SelectedGameType
    {
        get => _selectedGameType;
        set
        {
            if (Set(ref _selectedGameType, value))
            {
                OnPropertyChanged(nameof(SelectedGameLabel));
                OnPropertyChanged(nameof(IsXiangqiSelected));
                OnPropertyChanged(nameof(IsGomokuSelected));
            }
        }
    }
    public string SelectedGameLabel => SelectedGameType == "gomoku" ? "五子棋" : "中国象棋";

    // ---------------- 人机难度档位 ----------------
    public class AiLevelOption
    {
        public string Id { get; set; } = "";
        public string Label { get; set; } = "";
    }
    public System.Collections.Generic.List<AiLevelOption> AiLevelOptions { get; } = new()
    {
        new AiLevelOption { Id = "rookie", Label = "新手" },
        new AiLevelOption { Id = "easy", Label = "入门" },
        new AiLevelOption { Id = "medium", Label = "进阶" },
        new AiLevelOption { Id = "hard", Label = "高手" },
        new AiLevelOption { Id = "master", Label = "大师" },
    };
    private string _selectedAiLevel = "medium";
    public string SelectedAiLevel { get => _selectedAiLevel; set => Set(ref _selectedAiLevel, value); }

    private bool _aiPanelOpen;
    /// <summary>点击"人机对战"后展开难度选择面板</summary>
    public bool AiPanelOpen { get => _aiPanelOpen; set => Set(ref _aiPanelOpen, value); }
    public bool IsXiangqiSelected
    {
        get => SelectedGameType != "gomoku";
        set { if (value) SelectedGameType = "xiangqi"; }
    }
    public bool IsGomokuSelected
    {
        get => SelectedGameType == "gomoku";
        set { if (value) SelectedGameType = "gomoku"; }
    }

    private string _lobbyChatInput = "";
    public string LobbyChatInput { get => _lobbyChatInput; set => Set(ref _lobbyChatInput, value); }
    private string _roomChatInput = "";
    public string RoomChatInput { get => _roomChatInput; set => Set(ref _roomChatInput, value); }

    // ---------------- 对局设置（房主在开局前配置，服务端权威生效） ----------------

    private int[] _timeLimitOptions = { 15, 30, 60, 90, 120, 180, 300, 600 };
    /// <summary>每步时限可选项（秒）；服务器使用自定义默认时限时自动补充该选项</summary>
    public int[] TimeLimitOptions
    {
        get => _timeLimitOptions;
        private set => Set(ref _timeLimitOptions, value);
    }

    /// <summary>局时可选项（秒）：0=关闭</summary>
    public int[] GameTimeOptions { get; } = { 0, 180, 300, 600, 1200 };

    /// <summary>局时下拉显示文本</summary>
    public string[] GameTimeOptionLabels { get; } = { "无（仅步时）", "3 分钟", "5 分钟", "10 分钟", "20 分钟" };

    /// <summary>先后手选项：index 0=房主先手（象棋红方/五子棋黑方），1=对方先手</summary>
    public string[] FirstMoveOptions { get; } = { "我先手", "对方先手" };

    private int _selectedTimeLimit = 60;
    public int SelectedTimeLimit
    {
        get => _selectedTimeLimit;
        set { if (Set(ref _selectedTimeLimit, value)) SendRoomConfig(); }
    }

    private int _selectedGameTimeIndex;
    /// <summary>局时选项索引（对应 GameTimeOptions）</summary>
    public int SelectedGameTimeIndex
    {
        get => _selectedGameTimeIndex;
        set
        {
            if (Set(ref _selectedGameTimeIndex, value))
            {
                OnPropertyChanged(nameof(SelectedGameTime));
                SendRoomConfig();
            }
        }
    }

    public int SelectedGameTime =>
        SelectedGameTimeIndex >= 0 && SelectedGameTimeIndex < GameTimeOptions.Length
            ? GameTimeOptions[SelectedGameTimeIndex]
            : 0;

    private int _firstMoveIndex;
    public int FirstMoveIndex
    {
        get => _firstMoveIndex;
        set { if (Set(ref _firstMoveIndex, value)) SendRoomConfig(); }
    }

    /// <summary>回显服务器配置时抑制发送，避免回环</summary>
    private bool _syncingGameConfig;

    /// <summary>等待中才显示对局设置面板</summary>
    public bool ShowGameConfig => Room != null && Room.Status == "waiting";

    /// <summary>仅房主且等待中可修改</summary>
    public bool CanConfigureGame => ShowGameConfig && IsOwner;

    /// <summary>当前对局设置摘要（所有人可见；房间未携带配置时回显本地选择）</summary>
    public string GameConfigText
    {
        get
        {
            var cfg = Room?.Config;
            var tl = cfg?.TimeLimit ?? SelectedTimeLimit;
            var gt = cfg?.GameTime ?? SelectedGameTime;
            var opponentFirst = cfg?.FirstMove == "opponent" || (cfg == null && FirstMoveIndex == 1);
            var gtText = gt <= 0 ? "无局时" : $"局时 {gt / 60} 分";
            return $"每步 {tl} 秒 · {gtText} · {(opponentFirst ? "对方先手" : "房主先手")}";
        }
    }

    /// <summary>用服务器推送的房间配置刷新本地选择（不触发上报）。
    /// 房间未携带配置（如连接到旧版本服务器）时保留本地选择，避免被误重置。</summary>
    private void SyncGameConfigFromRoom()
    {
        _syncingGameConfig = true;
        try
        {
            var cfg = Room?.Config;
            if (cfg != null)
            {
                // 服务器自定义时限不在预设选项中时动态补入，保证下拉框能正确显示
                if (!TimeLimitOptions.Contains(cfg.TimeLimit))
                {
                    TimeLimitOptions = TimeLimitOptions.Concat(new[] { cfg.TimeLimit }).OrderBy(v => v).ToArray();
                }
                SelectedTimeLimit = cfg.TimeLimit;
                var gtIdx = Array.IndexOf(GameTimeOptions, cfg.GameTime);
                SelectedGameTimeIndex = gtIdx >= 0 ? gtIdx : 0;
                FirstMoveIndex = cfg.FirstMove == "opponent" ? 1 : 0;
            }
            OnPropertyChanged(nameof(ShowGameConfig));
            OnPropertyChanged(nameof(CanConfigureGame));
            OnPropertyChanged(nameof(GameConfigText));
        }
        finally { _syncingGameConfig = false; }
    }

    /// <summary>房主修改设置后上报服务器（等待中才有效）</summary>
    private async void SendRoomConfig()
    {
        if (_syncingGameConfig || !CanConfigureGame || Room == null) return;
        await _conn.SendAsync("room.config", new
        {
            timeLimit = SelectedTimeLimit,
            gameTime = SelectedGameTime,
            firstMove = FirstMoveIndex == 1 ? "opponent" : "owner",
        });
    }

    // ---------------- 对局 ----------------

    private GameState? _game;
    public GameState? Game
    {
        get => _game;
        set
        {
            var prev = _game;
            if (Set(ref _game, value))
            {
                OnPropertyChanged(nameof(TurnText));
                OnPropertyChanged(nameof(ResultText));
                OnPropertyChanged(nameof(MyTurn));
                OnPropertyChanged(nameof(IsOwner));
                OnPropertyChanged(nameof(InPlayingGame));
                OnPropertyChanged(nameof(CanOfferDraw));
                OnPropertyChanged(nameof(PlayersInfo));
                OnPropertyChanged(nameof(IsBlackView));
                OnPropertyChanged(nameof(IsGomoku));
                OnPropertyChanged(nameof(IsXiangqi));
                OnPropertyChanged(nameof(HasGameClocks));
                OnPropertyChanged(nameof(ClocksText));
                RebuildMoveList();
                ResetTurnCountdown();
                PlayMoveSound(prev, value);
                System.Windows.Input.CommandManager.InvalidateRequerySuggested();
            }
        }
    }

    /// <summary>
    /// 走子/吃子/将军音效：仅当步数恰好增加一步时触发，
    /// 开局、悔棋、重开、中途进房（步数跳变）等场景不响。
    /// 最后一手（将死/五连）同样播放，避免胜利步静音。
    /// </summary>
    private static void PlayMoveSound(GameState? prev, GameState? next)
    {
        if (prev == null || next == null) return;
        var addedMoves = next.Moves.Count - prev.Moves.Count;
        var addedCount = next.MoveCount - prev.MoveCount;
        if (addedMoves != 1 && addedCount != 1) return;
        var last = next.LastMove;
        var captured = last != null && GetPiece(prev, last.To) != null;
        // 象棋绝杀（含吃将）用独立重音，不能跟普通将军混在一起
        if (next.Over && !next.IsDraw && next.Type != "gomoku"
            && (next.Reason?.Contains("绝杀") == true || next.Reason?.Contains("吃掉对方") == true))
        {
            SoundService.PlayMate();
            return;
        }
        var justChecked = !string.IsNullOrEmpty(next.Check) && next.Check != prev.Check;
        if (justChecked) SoundService.PlayCheck();
        else SoundService.PlayMove(captured);
    }

    /// <summary>
    /// 黑方视角：棋盘镜像翻转，黑方棋子显示在屏幕下方。
    /// 服务器约定 players[0] 恒为红方（象棋）/ 黑方（五子棋）；
    /// 五子棋双方共用同一棋盘方向，不翻转。观战者保持默认视角。
    /// </summary>
    public bool IsBlackView
    {
        get
        {
            if (IsGomoku) return false;
            if (Game == null || User == null) return false;
            if (Game.Players.Count < 2) return false;                       // 人机等单边场景不翻转
            if (!Game.Players.Any(p => p.Id == User.Id)) return false;      // 观战者保持红方视角
            return Game.Players[0].Id != User.Id;                            // 我是黑方才翻转
        }
    }

    /// <summary>当前房间/对局是否为五子棋</summary>
    public bool IsGomoku => (Game?.Type ?? Room?.GameType) == "gomoku";
    public bool IsXiangqi => !IsGomoku;

    private string SideMark(int index) => IsGomoku
        ? (index == 0 ? "⚫黑" : "⚪白")
        : (index == 0 ? "🔴红" : "⚫黑");

    private string SideName(int turn) => IsGomoku
        ? (turn == 0 ? "黑方" : "白方")
        : (turn == 0 ? "红方" : "黑方");

    // ---------------- 棋谱 ----------------

    private void RebuildMoveList()
    {
        MoveList.Clear();
        if (Game == null) return;
        var firstMoverId = Game.Players.Count > 0 ? Game.Players[0].Id : null;
        // 倒序插入：最新一手显示在最上面（编号仍按时间顺序）
        for (int i = Game.Moves.Count - 1; i >= 0; i--)
        {
            var m = Game.Moves[i];
            var isFirst = m.Player == firstMoverId;
            m.Display = $"第{i + 1}手　{SideMark(isFirst ? 0 : 1)}　{m.Notation}";
            MoveList.Add(m);
        }
    }

    // ---------------- 走子倒计时 ----------------

    private readonly System.Windows.Threading.DispatcherTimer _turnTimer = new()
    {
        Interval = TimeSpan.FromSeconds(1),
    };

    private int _turnRemaining;
    public int TurnRemaining
    {
        get => _turnRemaining;
        private set { if (Set(ref _turnRemaining, value)) OnPropertyChanged(nameof(TurnTimerText)); }
    }

    public string TurnTimerText
    {
        get
        {
            if (Game == null || Game.Over) return "";
            // 人机模式：不限制走子时间
            if (Room?.Mode == "ai")
            {
                if (Game.Players.Count > Game.Turn && Game.Players[Game.Turn].Name == "电脑")
                    return "🤖 电脑思考中";
                return "⏱ 无时间限制";
            }
            var color = SideName(Game.Turn);
            var step = $"⏱ {color} 步时 {Math.Max(0, TurnRemaining)} 秒";
            if (HasGameClocks)
            {
                return $"{step}\n{ClocksText}";
            }
            return step;
        }
    }

    /// <summary>是否启用了局时时钟</summary>
    public bool HasGameClocks => Game?.Clocks != null && Game.Clocks.Count > 0 && (Game.GameTime > 0 || Game.Clocks.Values.Any(v => v > 0));

    /// <summary>双方局时显示（mm:ss，&lt;30s 加 ⚠）</summary>
    public string ClocksText
    {
        get
        {
            if (Game?.Clocks == null || Game.Players.Count == 0) return "";
            var parts = new List<string>();
            for (var i = 0; i < Game.Players.Count; i++)
            {
                var p = Game.Players[i];
                var ms = Game.Clocks.TryGetValue(p.Id, out var left) ? left : 0;
                // 当前走子方再扣已用步时
                if (!Game.Over && i == Game.Turn && Room?.Mode != "ai")
                {
                    var elapsed = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Game.TurnStartedAt;
                    ms = Math.Max(0, ms - elapsed);
                }
                var sec = (int)Math.Ceiling(ms / 1000.0);
                var label = SideName(i);
                var warn = sec < 30 ? " ⚠" : "";
                parts.Add($"{label} {sec / 60:D2}:{sec % 60:D2}{warn}");
            }
            return "⌛ " + string.Join("  |  ", parts);
        }
    }

    private void ResetTurnCountdown()
    {
        TurnRemaining = Game?.TimeLimit ?? 0;
        UpdateTurnCountdown();
    }

    private void UpdateTurnCountdown()
    {
        if (Game == null || Game.Over)
        {
            TurnRemaining = 0;
            return;
        }
        var elapsedSec = (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Game.TurnStartedAt) / 1000.0;
        TurnRemaining = Math.Max(0, Game.TimeLimit - (int)Math.Ceiling(elapsedSec));
        OnPropertyChanged(nameof(ClocksText));
        OnPropertyChanged(nameof(HasGameClocks));
        OnPropertyChanged(nameof(TurnTimerText));
    }

    private void OnTurnTimerTick(object? sender, EventArgs e)
    {
        UpdateTurnCountdown();
    }

    // ---------------- 悔棋 ----------------

    private bool _undoPromptVisible;
    public bool UndoPromptVisible
    {
        get => _undoPromptVisible;
        set => Set(ref _undoPromptVisible, value);
    }

    private string _undoFrom = "";
    public string UndoFrom
    {
        get => _undoFrom;
        set { if (Set(ref _undoFrom, value)) OnPropertyChanged(nameof(UndoPromptText)); }
    }

    public string UndoPromptText => $"{UndoFrom} 请求悔棋（撤销最后一步）";

    // ---------------- 求和 ----------------

    private bool _drawPromptVisible;
    public bool DrawPromptVisible
    {
        get => _drawPromptVisible;
        set => Set(ref _drawPromptVisible, value);
    }

    private string _drawFrom = "";
    public string DrawFrom
    {
        get => _drawFrom;
        set { if (Set(ref _drawFrom, value)) OnPropertyChanged(nameof(DrawPromptText)); }
    }

    public string DrawPromptText => $"{DrawFrom} 请求求和";

    // ---------------- 走法提示 ----------------

    private Move2? _hint;
    /// <summary>服务端建议走法（棋盘金色虚线框高亮，任意新对局状态到达即清除）</summary>
    public Move2? Hint
    {
        get => _hint;
        set { if (Set(ref _hint, value)) OnPropertyChanged(nameof(HintText)); }
    }

    public string HintText => Hint != null ? "💡 金色虚线框为建议走法" : "";

    private Point2? _selectedFrom;
    public Point2? SelectedFrom { get => _selectedFrom; set => Set(ref _selectedFrom, value); }

    public bool CanAction => !Matching;

    public bool IsOwner => Room != null && User != null && Room.OwnerId == User.Id;

    public bool InPlayingGame => Game != null && !Game.Over && Room?.Status == "playing";

    public bool MyTurn
    {
        get
        {
            if (Game == null || Game.Over || User == null) return false;
            return Game.Players.Count > Game.Turn && Game.Players[Game.Turn].Id == User.Id;
        }
    }

    public string TurnText
    {
        get
        {
            if (Game == null) return "";
            if (Game.Over) return ResultText;
            var player = Game.Players.Count > Game.Turn ? Game.Players[Game.Turn] : null;
            // 人机模式：电脑回合显示思考提示
            if (Room?.Mode == "ai" && player?.Name == "电脑")
            {
                return "🤖 电脑思考中…";
            }
            var color = SideName(Game.Turn);
            var check = !IsGomoku && Game.Check != null ? "（将军！）" : "";
            var mine = player?.Id == User?.Id;
            return $"{(mine ? "轮到你了" : $"等待 {player?.Name}")} · {color}走棋{check}";
        }
    }

    public string ResultText
    {
        get
        {
            if (Game == null || !Game.Over) return "";
            if (Game.IsDraw) return $"平局：{Game.Reason}";
            var winnerName = Game.Players.FirstOrDefault(p => p.Id == Game.WinnerId)?.Name ?? "";
            var mine = Game.WinnerId == User?.Id;
            return $"{(mine ? "🎉 你赢了！" : $"😔 {winnerName} 获胜")} — {Game.Reason}";
        }
    }

    public string PlayersInfo
    {
        get
        {
            if (Game == null) return "";
            return string.Join("　", Game.Players.Select((p, i) => $"{SideMark(i)} {p.Name}"));
        }
    }

    public bool CanStart
    {
        get
        {
            if (Room == null || !IsOwner || Room.Status != "waiting") return false;
            return Room.Players.Count >= 2 && Room.Players.All(p => p.Ready);
        }
    }

    public string ReadyButtonText
    {
        get
        {
            if (Room == null || User == null) return "就绪";
            var me = Room.Players.FirstOrDefault(p => p.Id == User.Id);
            return me?.Ready == true ? "取消就绪" : "就绪";
        }
    }

    // ---------------- 命令 ----------------

    public RelayCommand CreateRoomCmd { get; }
    public RelayCommand StartAiCmd { get; }
    public RelayCommand OpenAiPanelCmd { get; }
    public RelayCommand CloseAiPanelCmd { get; }
    public RelayCommand QuickJoinCmd { get; }
    public RelayCommand MatchCmd { get; }
    public RelayCommand LeaveRoomCmd { get; }
    public RelayCommand ReadyCmd { get; }
    public RelayCommand StartCmd { get; }
    public RelayCommand SurrenderCmd { get; }
    public RelayCommand DrawOfferCmd { get; }
    public RelayCommand AgreeDrawCmd { get; }
    public RelayCommand RejectDrawCmd { get; }
    public RelayCommand RestartCmd { get; }
    public RelayCommand SendLobbyChatCmd { get; }
    public RelayCommand SendRoomChatCmd { get; }
    public RelayCommand CellClickCmd { get; }
    public RelayCommand SwitchModeCommand { get; }
    public RelayCommand UndoCmd { get; }
    public RelayCommand HintCmd { get; }
    public RelayCommand AgreeUndoCmd { get; }
    public RelayCommand RejectUndoCmd { get; }

    // 好友与定向邀请
    public RelayCommand AddFriendCmd { get; }
    public RelayCommand AcceptFriendCmd { get; }
    public RelayCommand RejectFriendCmd { get; }
    public RelayCommand RemoveFriendCmd { get; }
    public RelayCommand SendInviteCmd { get; }
    public RelayCommand OpenPrivateChatCmd { get; }
    public RelayCommand ClosePrivateChatCmd { get; }
    public RelayCommand SendPrivateChatCmd { get; }

    // 头像
    public RelayCommand OpenAvatarPanelCmd { get; }
    public RelayCommand CloseAvatarPanelCmd { get; }
    public RelayCommand SelectAvatarCmd { get; }

    // 复盘
    public RelayCommand ReplayMatchCmd { get; }
    public RelayCommand CloseReplayCmd { get; }
    public RelayCommand ReplayPrevCmd { get; }
    public RelayCommand ReplayNextCmd { get; }
    public RelayCommand ReplayFirstCmd { get; }
    public RelayCommand ReplayLastCmd { get; }

    // ---------------- 动作 ----------------

    /// <summary>登录/注册/游客请求的超时控制：10 秒无响应则提示</summary>
    private CancellationTokenSource? _authTimeout;
    private const int AuthTimeoutMs = 10000;

    private void BeginAuthTimeout(string timeoutMessage)
    {
        _authTimeout?.Cancel();
        var cts = new CancellationTokenSource();
        _authTimeout = cts;
        Task.Delay(AuthTimeoutMs, cts.Token).ContinueWith(t =>
        {
            if (t.IsCanceled || cts.IsCancellationRequested) return;
            Ui(() =>
            {
                FormError = timeoutMessage;
                StatusText = timeoutMessage;
            });
        });
    }

    private void CancelAuthTimeout()
    {
        try { _authTimeout?.Cancel(); } catch { /* 忽略 */ }
        _authTimeout = null;
    }

    /// <summary>
    /// 确保已连接到服务器（地址变化时自动切换并重连）。
    /// 地址不合法或连接失败时在表单给出提示并返回 false，绝不抛异常崩溃。
    /// </summary>
    private async Task<bool> EnsureConnectedAsync()
    {
        var err = ServerConnection.ValidateServerUrl(ServerUrl, out var normalized);
        if (err != null)
        {
            FormError = err;
            StatusText = "服务器地址不合法：" + err;
            return false;
        }

        // 地址有变化（含规范化差异）时更新连接目标
        if (!string.Equals(_conn.TargetHttpUrl, normalized, StringComparison.OrdinalIgnoreCase))
        {
            var setErr = _conn.SetServerUrl(normalized);
            if (setErr != null)
            {
                FormError = setErr;
                StatusText = "服务器地址不合法：" + setErr;
                return false;
            }
        }

        if (_conn.IsConnected) return true;

        FormError = "";
        StatusText = "正在连接服务器…";
        _conn.Connect();
        if (await _conn.WaitConnectedAsync(TimeSpan.FromSeconds(12)))
        {
            StatusText = "已连接服务器，请登录或注册";
            return true;
        }

        FormError = "无法连接到服务器，请检查服务器地址和网络";
        StatusText = "连接失败：服务器无响应";
        return false;
    }

    /// <summary>登录</summary>
    public async void LoginAsync()
    {
        var name = LoginName.Trim();
        var pass = LoginPassword;
        if (name.Length == 0 || pass.Length == 0) { FormError = "请输入昵称和密码"; return; }
        if (!await EnsureConnectedAsync()) return;
        FormError = "";
        StatusText = "正在登录…";
        BeginAuthTimeout("登录超时：服务器无响应，请检查网络或服务器地址");
        await _conn.SendAsync("auth.login", new { name, password = pass });
    }

    /// <summary>注册（先本地校验再提交）</summary>
    public async void RegisterAsync()
    {
        ValidateRegister();
        if (!CanRegister)
        {
            if (FormError.Length == 0) FormError = "请完整填写注册信息";
            return;
        }
        if (!await EnsureConnectedAsync()) return;
        var name = RegisterName.Trim();
        FormError = "";
        StatusText = "正在注册…";
        BeginAuthTimeout("注册超时：服务器无响应，请检查网络或服务器地址");
        await _conn.SendAsync("auth.register", new { name, password = RegisterPassword });
    }

    /// <summary>游客进入</summary>
    public async void GuestAsync()
    {
        if (!await EnsureConnectedAsync()) return;
        StatusText = "正在以游客身份进入…";
        BeginAuthTimeout("连接超时：服务器无响应，请检查网络或服务器地址");
        await _conn.SendAsync("auth.guest");
    }

    /// <summary>切换登录/注册表单</summary>
    public void SwitchMode(bool register)
    {
        RegisterMode = register;
        if (register)
        {
            LoginName = "";
            LoginPassword = "";
        }
        else
        {
            RegisterName = "";
            RegisterPassword = "";
            RegisterConfirm = "";
        }
        StatusText = "已连接服务器，请登录或注册";
    }

    /// <summary>重新拉取个人历史战绩</summary>
    public async void RefreshMyMatches()
    {
        if (User == null) return;
        await _conn.SendAsync("matches.get", new { userId = User.Id, limit = 50 });
    }

    /// <summary>重置到登录页（清空会话状态，不处理连接）</summary>
    private void ResetToLogin()
    {
        User = null;
        Room = null;
        Game = null;
        RoomList.Clear();
        Rankings.Clear();
        LobbyChats.Clear();
        RoomChats.Clear();
        MyMatches.Clear();
        MoveList.Clear();
        UndoPromptVisible = false;
        DrawPromptVisible = false;
        Matching = false;
        CurrentView = ViewMode.Login;
        RegisterMode = false;
    }

    public async void LogoutAsync()
    {
        _conn.Token = "";
        ResetToLogin();
        // 记住账号：退出后恢复填充登录表单，方便下次直接登录
        LoginName = SavedName;
        LoginPassword = SavedPassword;
        RegisterName = "";
        RegisterPassword = "";
        RegisterConfirm = "";
        StatusText = "已退出登录";
        // 断开并重连：让服务器释放当前连接上的登录状态
        await _conn.ReconnectAsync();
        StatusText = "已连接服务器，请登录或注册";
    }

    public async void CreateRoom()
    {
        await _conn.SendAsync("room.create", new
        {
            gameType = SelectedGameType,
            name = RoomNameInput.Trim(),
            password = string.IsNullOrEmpty(RoomPasswordInput) ? null : RoomPasswordInput,
            @private = RoomPrivateInput,
        });
        RoomNameInput = "";
        RoomPasswordInput = "";
        RoomPrivateInput = false;
    }

    public async void JoinRoom(string roomId, bool hasPassword)
    {
        string? password = null;
        if (hasPassword)
        {
            var dlg = new InputDialog("房间密码", $"房间 {roomId} 需要密码：");
            if (dlg.ShowDialog() != true) return;
            password = dlg.Value;
        }
        await _conn.SendAsync("room.join", new { roomId, password });
    }

    /// <summary>匹配开关：未排队时按当前所选游戏入队（服务端按积分窗口配对），排队中再次点击取消</summary>
    public async void ToggleMatch()
    {
        if (Matching) await _conn.SendAsync("match.dequeue");
        else await _conn.SendAsync("match.enqueue", new { gameType = SelectedGameType });
    }

    public async void ToggleReady()
    {
        if (Room == null || User == null) return;
        var me = Room.Players.FirstOrDefault(p => p.Id == User.Id);
        await _conn.SendAsync("room.ready", new { ready = !(me?.Ready ?? false) });
    }

    /// <summary>认输前弹窗确认，防止误触直接判负</summary>
    private async Task SurrenderConfirmAsync()
    {
        var owner = Application.Current?.MainWindow;
        var r = MessageBox.Show(owner, "确定要认输吗？认输后将立即判负。", "确认认输",
            MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No);
        if (r != MessageBoxResult.Yes) return;
        await _conn.SendAsync("game.surrender");
    }

    private async Task DrawOfferConfirmAsync()
    {
        if (!CanOfferDraw) return;
        var owner = Application.Current?.MainWindow;
        var r = MessageBox.Show(owner, "向对方提出和棋？需对方同意后才会结束对局。", "确认求和",
            MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No);
        if (r != MessageBoxResult.Yes) return;
        StatusText = "已发送求和请求，等待对方回应…";
        await _conn.SendAsync("game.drawOffer");
    }

    // ---------------- 好友与定向邀请 ----------------

    private static string IdOf(object? p)
    {
        if (p is FriendInfo fi) return fi.Id;
        if (p is FriendRequestInfo fri) return fri.Id;
        return p?.ToString() ?? "";
    }

    /// <summary>主动拉取好友列表与请求快照</summary>
    public void RefreshFriends() => _ = _conn.SendAsync("friend.list");

    private void AddFriend()
    {
        var name = FriendAddInput.Trim();
        if (name.Length == 0) return;
        FriendAddInput = "";
        _ = _conn.SendAsync("friend.add", new { name });
    }

    private void AcceptFriend(string friendId)
    {
        if (friendId.Length == 0) return;
        _ = _conn.SendAsync("friend.accept", new { friendId });
    }

    private void RejectFriend(string friendId)
    {
        if (friendId.Length == 0) return;
        _ = _conn.SendAsync("friend.reject", new { friendId });
    }

    private void RemoveFriend(string friendId)
    {
        if (friendId.Length == 0) return;
        var owner = Application.Current?.MainWindow;
        var r = MessageBox.Show(owner, "确定要删除该好友吗？删除后需重新添加。", "删除好友",
            MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No);
        if (r != MessageBoxResult.Yes) return;
        _ = _conn.SendAsync("friend.remove", new { friendId });
    }

    private void SendInviteFromSelection()
    {
        if (SelectedFriend == null || Room == null) return;
        _ = _conn.SendAsync("invite.send", new { friendId = SelectedFriend.Id, roomId = Room.Id });
    }

    // ---------------- 好友私聊 ----------------

    /// <summary>收到私聊消息时播放的提示音（合成柔和三音上行，不依赖外部文件）</summary>
    private void PlayPrivateNotifySound()
    {
        try
        {
            var samples = new System.Collections.Generic.List<short>();
            AddTone(samples, 659.25, 0.10);  // E5
            AddTone(samples, 783.99, 0.12);  // G5
            AddTone(samples, 1046.5, 0.20);  // C6 收尾，轻快悦耳
            int sampleRate = 44100;
            int dataLen = samples.Count * 2;
            var ms = new System.IO.MemoryStream();
            using (var writer = new System.IO.BinaryWriter(ms, System.Text.Encoding.ASCII, true))
            {
                writer.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
                writer.Write(36 + dataLen);
                writer.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));
                writer.Write(System.Text.Encoding.ASCII.GetBytes("fmt "));
                writer.Write(16);
                writer.Write((short)1);   // PCM
                writer.Write((short)1);   // 单声道
                writer.Write(sampleRate);
                writer.Write(sampleRate * 2);
                writer.Write((short)2);
                writer.Write((short)16);
                writer.Write(System.Text.Encoding.ASCII.GetBytes("data"));
                writer.Write(dataLen);
                foreach (var s in samples) writer.Write(s);
            }
            ms.Position = 0;
            _notifyPlayer = new System.Media.SoundPlayer(ms);  // 持有流，避免被回收
            _notifyPlayer.Play();
        }
        catch { try { System.Media.SystemSounds.Asterisk.Play(); } catch { /* 忽略音频不可用 */ } }
    }

    private static void AddTone(System.Collections.Generic.List<short> samples, double freq, double seconds)
    {
        int sampleRate = 44100;
        int n = (int)(sampleRate * seconds);
        for (int i = 0; i < n; i++)
        {
            double t = (double)i / sampleRate;
            // 短时淡入淡出，避免爆音
            double env = System.Math.Min(1.0, t / 0.01) * System.Math.Min(1.0, (seconds - t) / 0.02);
            short v = (short)(System.Math.Sin(2 * System.Math.PI * freq * t) * 32767 * 0.4 * env);
            samples.Add(v);
        }
    }

    private void SendPrivateChat()
    {
        var text = PrivateInput.Trim();
        if (text.Length == 0 || SelectedFriendChat == null) return;
        PrivateInput = "";
        var otherId = SelectedFriendChat.Id;
        if (!_privateChats.ContainsKey(otherId)) _privateChats[otherId] = new ObservableCollection<ChatMessage>();
        _privateChats[otherId].Insert(0, new ChatMessage
        {
            From = User?.Name ?? "我",
            Text = text,
            Ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            IsMine = true,
        });
        OnPropertyChanged(nameof(CurrentPrivateMessages));
        _ = _conn.SendAsync("chat.private", new { toId = otherId, text });
    }

    /// <summary>选择头像：发送到服务端并本地更新</summary>
    private void SelectAvatar(string? avatar)
    {
        if (string.IsNullOrEmpty(avatar) || User == null) return;
        User.Avatar = avatar;
        OnPropertyChanged(nameof(UserAvatar));
        AvatarPanelOpen = false;
        _ = _conn.SendAsync("avatar.update", new { avatar });
    }

    // ---------------- 复盘功能 ----------------

    private MatchDetail? _replayMatch;
    /// <summary>当前复盘的对局</summary>
    public MatchDetail? ReplayMatch { get => _replayMatch; set => Set(ref _replayMatch, value); }

    private int _replayIndex;
    /// <summary>当前复盘步数索引（0=初始局面）</summary>
    public int ReplayIndex { get => _replayIndex; set { if (Set(ref _replayIndex, value)) { OnPropertyChanged(nameof(ReplayStatusText)); OnPropertyChanged(nameof(CanReplayPrev)); OnPropertyChanged(nameof(CanReplayNext)); UpdateReplayBoard(); } } }

    /// <summary>复盘面板是否打开</summary>
    public bool ReplayPanelOpen => ReplayMatch != null;

    /// <summary>复盘状态文本</summary>
    public string ReplayStatusText => ReplayMatch == null ? "" : $"第 {ReplayIndex} / {ReplayMatch.MoveCount} 手";

    /// <summary>是否可以上一步</summary>
    public bool CanReplayPrev => ReplayMatch != null && ReplayIndex > 0;

    /// <summary>是否可以下一步</summary>
    public bool CanReplayNext => ReplayMatch != null && ReplayIndex < ReplayMatch.MoveCount;

    private GameState? _replayGame;
    /// <summary>复盘时的棋盘状态（根据 ReplayIndex 计算）</summary>
    public GameState? ReplayGame { get => _replayGame; set => Set(ref _replayGame, value); }

    /// <summary>请求复盘某个对局</summary>
    private void RequestReplay(MatchRecord? match)
    {
        if (match == null) return;
        _ = _conn.SendAsync("match.detail.get", new { matchId = match.Id });
        StatusText = "正在加载棋谱...";
    }

    /// <summary>收到对局详情，开始复盘</summary>
    private void OnMatchDetail(JsonElement payload)
    {
        if (!payload.TryGetProperty("match", out var m)) return;
        var detail = m.Deserialize<MatchDetail>(ServerConnection.JsonOpts);
        if (detail == null) return;
        Ui(() =>
        {
            ReplayMatch = detail;
            ReplayIndex = 0;
            StatusText = $"复盘：{detail.GameType} ({detail.MoveCount} 手)";
            OnPropertyChanged(nameof(ReplayPanelOpen));
            UpdateReplayBoard();
        });
    }

    /// <summary>关闭复盘面板</summary>
    private void CloseReplay()
    {
        ReplayMatch = null;
        ReplayIndex = 0;
        ReplayGame = null;
        OnPropertyChanged(nameof(ReplayPanelOpen));
    }

    /// <summary>上一步</summary>
    private void ReplayPrev()
    {
        if (CanReplayPrev) ReplayIndex--;
    }

    /// <summary>下一步</summary>
    private void ReplayNext()
    {
        if (CanReplayNext) ReplayIndex++;
    }

    /// <summary>跳到第一步</summary>
    private void ReplayFirst()
    {
        ReplayIndex = 0;
    }

    /// <summary>跳到最后一步</summary>
    private void ReplayLast()
    {
        if (ReplayMatch != null) ReplayIndex = ReplayMatch.MoveCount;
    }

    /// <summary>根据当前步数重建棋盘状态</summary>
    private void UpdateReplayBoard()
    {
        if (ReplayMatch == null) { ReplayGame = null; return; }

        // 创建初始棋盘
        var game = new GameState
        {
            Type = ReplayMatch.GameType,
            Cols = ReplayMatch.GameType == "gomoku" ? 15 : 9,
            Rows = ReplayMatch.GameType == "gomoku" ? 15 : 10,
            Turn = 0,
            MoveCount = 0,
            Moves = new List<MoveRecord>(),
            Players = ReplayMatch.Players.Select(p => new GamePlayer { Id = p.Id, Name = p.Name }).ToList(),
        };

        // 初始化棋盘
        if (ReplayMatch.GameType == "xiangqi")
        {
            game.Board = CreateInitialXiangqiBoard();
        }
        else
        {
            game.Board = new string?[15][];
            for (int i = 0; i < 15; i++) game.Board[i] = new string?[15];
        }

        // 应用前 ReplayIndex 步
        for (int i = 0; i < ReplayIndex && i < ReplayMatch.Moves.Count; i++)
        {
            var mv = ReplayMatch.Moves[i];
            ApplyMoveToBoard(game, mv, i);
        }

        game.MoveCount = ReplayIndex;
        ReplayGame = game;
    }

    /// <summary>创建象棋初始棋盘</summary>
    private static string?[][] CreateInitialXiangqiBoard()
    {
        var board = new string?[10][];
        for (int i = 0; i < 10; i++) board[i] = new string?[9];
        // 黑方（上方）：br=车 bh=马 be=象 ba=士 bk=将
        board[0][0] = "br"; board[0][1] = "bh"; board[0][2] = "be"; board[0][3] = "ba"; board[0][4] = "bk"; board[0][5] = "ba"; board[0][6] = "be"; board[0][7] = "bh"; board[0][8] = "br";
        board[2][1] = "bc"; board[2][7] = "bc";
        board[3][0] = "bp"; board[3][2] = "bp"; board[3][4] = "bp"; board[3][6] = "bp"; board[3][8] = "bp";
        // 红方（下方）：rr=车 rh=马 re=相 ra=仕 rk=帅
        board[9][0] = "rr"; board[9][1] = "rh"; board[9][2] = "re"; board[9][3] = "ra"; board[9][4] = "rk"; board[9][5] = "ra"; board[9][6] = "re"; board[9][7] = "rh"; board[9][8] = "rr";
        board[7][1] = "rc"; board[7][7] = "rc";
        board[6][0] = "rp"; board[6][2] = "rp"; board[6][4] = "rp"; board[6][6] = "rp"; board[6][8] = "rp";
        return board;
    }

    /// <summary>在棋盘上应用一步移动</summary>
    private static void ApplyMoveToBoard(GameState game, MoveRecord mv, int moveIndex)
    {
        if (game.Board == null) return;
        var piece = game.Board[mv.From.Y][mv.From.X];
        game.Board[mv.From.Y][mv.From.X] = null;
        game.Board[mv.To.Y][mv.To.X] = piece;
        game.Turn = 1 - game.Turn;
        game.Moves.Add(mv);
    }

    private void OnPrivateChat(JsonElement payload)
    {
        var fromId = payload.TryGetProperty("fromId", out var f) ? f.GetString() ?? "" : "";
        var fromName = payload.TryGetProperty("fromName", out var fn) ? fn.GetString() ?? "好友" : "好友";
        var toId = payload.TryGetProperty("toId", out var t) ? t.GetString() ?? "" : "";
        var text = payload.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "";
        var ts = payload.TryGetProperty("ts", out var tsEl) ? tsEl.GetInt64() : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var otherId = fromId == User?.Id ? toId : fromId;
        Ui(() =>
        {
            if (!_privateChats.ContainsKey(otherId)) _privateChats[otherId] = new ObservableCollection<ChatMessage>();
            _privateChats[otherId].Insert(0, new ChatMessage
            {
                From = fromName,
                Text = text,
                Ts = ts,
                IsMine = fromId == User?.Id,
            });
            OnPropertyChanged(nameof(CurrentPrivateMessages));
            // 收到新消息即播放提示音
            PlayPrivateNotifySound();
            // 仅当未正在查看该好友对话时记为未读（红点）
            if (_selectedFriendChat == null || _selectedFriendChat.Id != otherId)
            {
                if (!_unread.ContainsKey(otherId)) _unread[otherId] = 0;
                _unread[otherId]++;
                OnPropertyChanged(nameof(HasUnreadPrivate));
                OnPropertyChanged(nameof(UnreadPrivateCount));
                RefreshFriendUnread(otherId, _unread[otherId]);
            }
        });
    }

    /// <summary>更新好友列表中指定好友的未读数显示</summary>
    private void RefreshFriendUnread(string friendId, int count)
    {
        foreach (var f in Friends)
        {
            if (f.Id == friendId)
            {
                f.UnreadCount = count;
                // 触发列表项刷新
                var idx = Friends.IndexOf(f);
                if (idx >= 0)
                {
                    Friends.RemoveAt(idx);
                    Friends.Insert(idx, f);
                }
                break;
            }
        }
    }


    private void OnFriendList(JsonElement payload)
    {
        Ui(() =>
        {
            Friends.Clear();
            FriendRequests.Clear();
            OutgoingRequests.Clear();
            if (payload.TryGetProperty("friends", out var fs))
                foreach (var f in fs.EnumerateArray())
                {
                    var friend = f.Deserialize<FriendInfo>(ServerConnection.JsonOpts)!;
                    // 恢复未读数
                    if (_unread.TryGetValue(friend.Id, out var cnt))
                        friend.UnreadCount = cnt;
                    Friends.Add(friend);
                }
            if (payload.TryGetProperty("incoming", out var inc))
                foreach (var f in inc.EnumerateArray())
                    FriendRequests.Add(f.Deserialize<FriendRequestInfo>(ServerConnection.JsonOpts)!);
            if (payload.TryGetProperty("outgoing", out var outg))
                foreach (var f in outg.EnumerateArray())
                    OutgoingRequests.Add(f.Deserialize<FriendRequestInfo>(ServerConnection.JsonOpts)!);
            OnPropertyChanged(nameof(HasFriendRequests));
            OnPropertyChanged(nameof(FriendRequestCount));
            // 若正在私聊的好友已不在好友列表（被删除/被移除），关闭私聊窗口
            if (_selectedFriendChat != null)
            {
                bool stillFriend = false;
                foreach (var f in Friends)
                {
                    if (f.Id == _selectedFriendChat.Id) { stillFriend = true; break; }
                }
                if (!stillFriend) SelectedFriendChat = null;
            }
        });
    }

    private void OnFriendRequest(JsonElement payload)
    {
        var name = payload.TryGetProperty("name", out var n) ? n.GetString() ?? "好友" : "好友";
        _ = _conn.SendAsync("friend.list");
        Ui(() =>
        {
            var owner = Application.Current?.MainWindow;
            MessageBox.Show(owner, $"{name} 请求添加你为好友，已加入待处理列表。", "新的好友请求",
                MessageBoxButton.OK, MessageBoxImage.Information);
        });
    }

    private void OnInvite(JsonElement payload)
    {
        var invite = payload.Deserialize<InviteInfo>(ServerConnection.JsonOpts);
        if (invite == null) return;
        Ui(() =>
        {
            // 与私聊同源的提示音：收到对战邀请即时提醒
            PlayPrivateNotifySound();
            var owner = Application.Current?.MainWindow;
            var r = MessageBox.Show(owner,
                $"{invite.FromName} 邀请你加入「{invite.RoomName}」（{invite.GameName}），是否前往？",
                "好友对战邀请", MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.Yes);
            if (r != MessageBoxResult.Yes) return;
            if (Room != null) _ = _conn.SendAsync("room.leave");
            JoinRoom(invite.RoomId, !string.IsNullOrEmpty(invite.Password));
        });
    }

    private async void SendLobbyChat()
    {
        var text = LobbyChatInput.Trim();
        if (text.Length == 0) return;
        await _conn.SendAsync("chat.send", new { text, scope = "lobby" });
        LobbyChatInput = "";
    }

    private async void SendRoomChat()
    {
        var text = RoomChatInput.Trim();
        if (text.Length == 0) return;
        await _conn.SendAsync("chat.send", new { text, scope = "room" });
        RoomChatInput = "";
    }

    /// <summary>棋盘点击：象棋选子再走；五子棋直接在空点落子</summary>
    private async void OnCellClick(Point2 cell)
    {
        if (Game == null || Game.Over || !MyTurn) return;
        if (IsGomoku)
        {
            var occupied = GetPiece(Game, cell);
            if (occupied != null) return;
            await _conn.SendAsync("game.move", new { move = new { x = cell.X, y = cell.Y } });
            return;
        }
        var piece = GetPiece(Game, cell);
        if (SelectedFrom == null)
        {
            if (piece != null && IsMyPiece(piece))
            {
                SelectedFrom = cell;
                SoundService.PlaySelect();
            }
            return;
        }
        var from = SelectedFrom;
        // 已有选中时再点己方棋子：直接改选（换子无需先取消）；点同一枚则取消选中
        if (piece != null && IsMyPiece(piece))
        {
            SelectedFrom = (from.X == cell.X && from.Y == cell.Y) ? null : cell;
            if (SelectedFrom != null) SoundService.PlaySelect();
            return;
        }
        SelectedFrom = null;
        await _conn.SendAsync("game.move", new { move = new { from = new { x = from.X, y = from.Y }, to = new { x = cell.X, y = cell.Y } } });
    }

    private static string? GetPiece(GameState g, Point2 c)
        => g.Board != null && c.Y < g.Board.Length && c.X < (g.Board[c.Y]?.Length ?? 0) ? g.Board[c.Y][c.X] : null;

    private bool IsMyPiece(string code)
    {
        if (Game == null || User == null) return false;
        var myColor = Game.Players.Count > 0 && Game.Players[0].Id == User.Id ? 'r' : 'b';
        return code.Length > 0 && code[0] == myColor;
    }

    // ---------------- 消息处理 ----------------

    private void OnMessage(string type, JsonElement payload)
    {
        switch (type)
        {
            case "s.welcome":
                // 有令牌自动登录；无令牌停留在登录页由用户选择
                if (!string.IsNullOrEmpty(_conn.Token))
                {
                    BeginAuthTimeout("自动登录超时：服务器无响应，请检查网络或服务器地址");
                    _ = _conn.AuthWithTokenAsync(_conn.Token);
                }
                else
                    Ui(() => StatusText = "已连接服务器，请登录或注册");
                break;
            case "s.auth.ok":
                OnAuthOk(payload);
                break;
            case "s.auth.registered":
                CancelAuthTimeout();
                Ui(() =>
                {
                    var name = payload.TryGetProperty("name", out var n) ? n.GetString() : "";
                    RegisterMode = false; // 切回登录表单（同时清空注册字段与错误提示）
                    LoginName = string.IsNullOrEmpty(name) ? LoginName : name;
                    LoginPassword = "";
                    StatusText = "✅ 注册成功，请登录";
                });
                break;
            case "s.me.state":
                OnMeState(payload);
                break;
            case "s.room.list":
                OnRoomList(payload);
                break;
            case "s.room.joined":
                OnRoomJoined(payload);
                break;
            case "s.room.update":
                OnRoomUpdate(payload);
                break;
            case "s.room.left":
                OnRoomLeft(payload);
                break;
            case "s.game.start":
                OnGameStart(payload);
                break;
            case "s.game.state":
            case "s.game.move":
            case "s.game.restarted":
                SetGame(ExtractGame(payload));
                break;
            case "s.game.over":
                SetGame(ExtractGame(payload));
                StatusText = ResultText;
                UndoPromptVisible = false;
                DrawPromptVisible = false;
                RefreshMyMatches(); // 对局结束后刷新个人战绩
                // 胜利音效：仅胜者本人播放（平局不播）
                {
                    var wid = payload.TryGetProperty("winnerId", out var w) ? w.GetString() : null;
                    var draw = !payload.TryGetProperty("isDraw", out var d) || d.ValueKind == JsonValueKind.True;
                    if (!draw && wid != null && User != null && wid == User.Id)
                        SoundService.PlayVictory();
                }
                break;
            case "s.undo.requested":
                OnUndoRequested(payload);
                break;
            case "s.draw.requested":
                OnDrawRequested(payload);
                break;
            case "s.draw.response":
                Ui(() =>
                {
                    DrawPromptVisible = false;
                    var agree = payload.TryGetProperty("agree", out var a) && a.GetBoolean();
                    var byName = payload.TryGetProperty("byName", out var n) ? n.GetString() : "对方";
                    StatusText = agree ? "对方同意了求和" : $"{byName} 拒绝了求和";
                });
                break;
            case "s.hint":
                Ui(() =>
                {
                    var mv = payload.TryGetProperty("move", out var m) ? m.Deserialize<Move2>(ServerConnection.JsonOpts) : null;
                    if (mv == null) return;
                    Hint = mv;
                    StatusText = "💡 提示：金色虚线框为建议走法";
                });
                break;
            case "s.undo.response":
                Ui(() =>
                {
                    var agree = payload.TryGetProperty("agree", out var a) && a.GetBoolean();
                    var byName = payload.TryGetProperty("byName", out var n) ? n.GetString() : "对方";
                    StatusText = agree ? "对方同意了悔棋请求" : $"{byName} 拒绝了悔棋请求";
                });
                break;
            case "s.undo.done":
                Ui(() =>
                {
                    UndoPromptVisible = false;
                    DrawPromptVisible = false;
                    SetGame(ExtractGame(payload));
                    StatusText = "悔棋成功，已撤销最后一步";
                });
                break;
            case "s.undo.cancelled":
                Ui(() =>
                {
                    StatusText = payload.TryGetProperty("reason", out var r) ? r.GetString() ?? "悔棋请求已取消" : "悔棋请求已取消";
                });
                break;
            case "s.rating.update":
                OnRatingUpdate(payload);
                break;
            case "s.match.queued":
                Ui(() =>
                {
                    Matching = true;
                    var tip = payload.TryGetProperty("message", out var m) ? m.GetString() : null;
                    StatusText = string.IsNullOrWhiteSpace(tip) ? "正在匹配与您积分相近的对手…" : tip!;
                });
                break;
            case "s.match.found":
                Ui(() => { Matching = false; StatusText = "匹配成功！"; });
                break;
            case "s.match.timeout":
                Ui(() => { Matching = false; StatusText = "匹配超时，请重试"; });
                break;
            case "s.match.left":
                Ui(() => { Matching = false; StatusText = "已取消匹配"; });
                break;
            case "s.matches":
                Ui(() =>
                {
                    MyMatches.Clear();
                    if (payload.TryGetProperty("matches", out var arr))
                        foreach (var m in arr.EnumerateArray())
                            MyMatches.Add(m.Deserialize<MatchRecord>(ServerConnection.JsonOpts)!);
                });
                break;
            case "s.match.detail":
                OnMatchDetail(payload);
                break;
            case "s.friend.list":
                OnFriendList(payload);
                break;
            case "s.friend.request":
                OnFriendRequest(payload);
                break;
            case "s.friend.update":
                _ = _conn.SendAsync("friend.list");
                break;
            case "s.avatar.updated":
                // 头像更新成功，服务端已确认
                break;
            case "s.invite":
                OnInvite(payload);
                break;
            case "s.chat.private":
                OnPrivateChat(payload);
                break;
            case "s.chat":
                OnChat(payload);
                break;
            case "s.chat.history":
                Ui(() =>
                {
                    LobbyChats.Clear();
                    if (payload.TryGetProperty("messages", out var arr))
                        foreach (var m in arr.EnumerateArray())
                        {
                            var cm = m.Deserialize<ChatMessage>(ServerConnection.JsonOpts);
                            if (cm == null) continue;
                            cm.IsSystem = cm.From == "系统";
                            cm.IsMine = !cm.IsSystem && (cm.FromId == User?.Id || cm.From == User?.Name);
                            LobbyChats.Insert(0, cm);
                        }
                });
                break;
            case "s.ranking":
                Ui(() =>
                {
                    Rankings.Clear();
                    if (payload.TryGetProperty("rankings", out var arr))
                        foreach (var r in arr.EnumerateArray())
                            Rankings.Add(r.Deserialize<RankItem>(ServerConnection.JsonOpts)!);
                });
                break;
            case "s.auth.kicked":
                // 账号在其他设备登录（顶号下线）：清除令牌并断开，避免自动重连被反复顶号
                Ui(() =>
                {
                    _conn.Token = "";
                    _conn.Close();
                    Connected = false;
                    ResetToLogin();
                    var kickMsg = payload.TryGetProperty("message", out var k) ? k.GetString() : "您的账号已在其他设备登录，请重新登录";
                    FormError = kickMsg ?? "您的账号已在其他设备登录，请重新登录";
                    StatusText = kickMsg ?? "您的账号已在其他设备登录，请重新登录";
                });
                break;
            case "s.error":
                OnError(payload);
                break;
        }
    }

    private void OnAuthOk(JsonElement payload)
    {
        CancelAuthTimeout();
        Ui(() =>
        {
            User = payload.TryGetProperty("user", out var u) ? u.Deserialize<UserInfo>(ServerConnection.JsonOpts) : null;
            if (payload.TryGetProperty("token", out var t)) _conn.Token = t.GetString() ?? "";
            if (User != null)
            {
                // 正式账号登录成功：更新记住的账号（若勾选）
                if (!User.IsGuest && RememberAccount)
                {
                    SavedName = User.Name;
                    SavedPassword = LoginPassword;
                }
                AddAccountHistory(User.Name);
                CurrentView = ViewMode.Lobby;
                StatusText = $"欢迎，{User.Name}！";
                RefreshMyMatches();
            }
        });
    }

    private void OnMeState(JsonElement payload)
    {
        Ui(() =>
        {
            if (payload.TryGetProperty("user", out var u)) User = u.Deserialize<UserInfo>(ServerConnection.JsonOpts);
            Room = payload.TryGetProperty("room", out var r) && r.ValueKind == JsonValueKind.Object
                ? r.Deserialize<RoomInfo>(ServerConnection.JsonOpts) : null;
            Matching = payload.TryGetProperty("matching", out var m) && m.ValueKind == JsonValueKind.Object;
            Game = Room?.Game;
            CurrentView = Room != null ? ViewMode.Room : ViewMode.Lobby;
            SelectedFrom = null;
            OnPropertyChanged(nameof(CanStart));
            if (User != null) RefreshMyMatches();
        });
    }

    private void OnRoomList(JsonElement payload)
    {
        Ui(() =>
        {
            RoomList.Clear();
            if (payload.TryGetProperty("rooms", out var arr))
                foreach (var r in arr.EnumerateArray())
                    RoomList.Add(r.Deserialize<RoomListItem>(ServerConnection.JsonOpts)!);
        });
    }

    private void OnRoomJoined(JsonElement payload)
    {
        Ui(() =>
        {
            Room = payload.TryGetProperty("room", out var r) ? r.Deserialize<RoomInfo>(ServerConnection.JsonOpts) : null;
            Game = Room?.Game;
            SelectedFrom = null;
            CurrentView = ViewMode.Room;
            OnPropertyChanged(nameof(CanStart));
            StatusText = Room != null ? $"已进入房间 {Room.Name}" : "加入房间失败";
        });
    }

    private void OnRoomUpdate(JsonElement payload)
    {
        Ui(() =>
        {
            if (payload.TryGetProperty("room", out var r))
            {
                var updated = r.Deserialize<RoomInfo>(ServerConnection.JsonOpts);
                if (Room != null && updated != null && updated.Id == Room.Id)
                {
                    Room = updated;
                    Game = updated.Game;
                    OnPropertyChanged(nameof(CanStart));
                }
            }
        });
    }

    private void OnRoomLeft(JsonElement payload)
    {
        Ui(() =>
        {
            var kicked = payload.TryGetProperty("kicked", out var k) && k.GetBoolean();
            Room = null;
            Game = null;
            Hint = null;
            RoomChats.Clear();
            SelectedFrom = null;
            CurrentView = ViewMode.Lobby;
            StatusText = kicked ? "你已被移出房间" : "已离开房间";
        });
    }

    private void OnGameStart(JsonElement payload)
    {
        Ui(() =>
        {
            SetGame(ExtractGame(payload));
            StatusText = IsGomoku ? "对局开始！黑方先行" : "对局开始！红方先行";
        });
    }

    private void SetGame(GameState? g)
    {
        Ui(() =>
        {
            Game = g;
            SelectedFrom = null;
            Hint = null;
        });
    }

    private static GameState? ExtractGame(JsonElement payload)
        => payload.TryGetProperty("game", out var g) ? g.Deserialize<GameState>(ServerConnection.JsonOpts) : null;

    private void OnRatingUpdate(JsonElement payload)
    {
        Ui(() =>
        {
            if (User == null || !payload.TryGetProperty("users", out var arr)) return;
            foreach (var u in arr.EnumerateArray())
            {
                var info = u.Deserialize<UserInfo>(ServerConnection.JsonOpts);
                if (info?.Id == User.Id) { User = info; break; }
            }
        });
    }

    private void OnChat(JsonElement payload)
    {
        Ui(() =>
        {
            var msg = payload.Deserialize<ChatMessage>(ServerConnection.JsonOpts);
            if (msg == null) return;
            msg.IsSystem = msg.From == "系统";
            msg.IsMine = !msg.IsSystem && (msg.FromId == User?.Id || msg.From == User?.Name);
            if (msg.Scope == "lobby") LobbyChats.Insert(0, msg);
            else RoomChats.Insert(0, msg);
            while (LobbyChats.Count > 100) LobbyChats.RemoveAt(LobbyChats.Count - 1);
            while (RoomChats.Count > 100) RoomChats.RemoveAt(RoomChats.Count - 1);
        });
    }

    private void OnUndoRequested(JsonElement payload)
    {
        Ui(() =>
        {
            var byName = payload.TryGetProperty("byName", out var n) ? n.GetString() : "对方";
            var mine = payload.TryGetProperty("mine", out var m) && m.GetBoolean();
            if (mine)
            {
                StatusText = "已发送悔棋请求，等待对方回应…";
            }
            else
            {
                UndoFrom = byName ?? "对方";
                UndoPromptVisible = true;
            }
        });
    }

    private void OnDrawRequested(JsonElement payload)
    {
        Ui(() =>
        {
            var byName = payload.TryGetProperty("byName", out var n) ? n.GetString() : "对方";
            var mine = payload.TryGetProperty("mine", out var m) && m.ValueKind == JsonValueKind.True && m.GetBoolean();
            if (mine)
            {
                StatusText = "已发送求和请求，等待对方回应…";
                return;
            }

            // 弹窗确认，避免左侧提示条被挤出视野导致“求和不能用”
            DrawFrom = byName ?? "对方";
            DrawPromptVisible = true;
            PlayPrivateNotifySound();
            var owner = Application.Current?.MainWindow;
            var r = MessageBox.Show(owner,
                $"{DrawFrom} 请求求和，是否同意？",
                "求和请求",
                MessageBoxButton.YesNo,
                MessageBoxImage.Question,
                MessageBoxResult.No);
            DrawPromptVisible = false;
            _ = _conn.SendAsync("game.drawRespond", new { agree = r == MessageBoxResult.Yes });
            StatusText = r == MessageBoxResult.Yes ? "你已同意求和" : "你已拒绝求和";
        });
    }

    private void OnError(JsonElement payload)
    {
        CancelAuthTimeout();
        Ui(() =>
        {
            var msg = payload.TryGetProperty("message", out var m) ? m.GetString() : "操作失败";
            var code = payload.TryGetProperty("code", out var c) ? c.GetString() : "";
            // 令牌失效（已过期 / 被其他设备顶号）：清除本地令牌，避免反复自动重登
            if (code == "AUTH_TOKEN_INVALID")
            {
                _conn.Token = "";
                Connected = false;
                if (CurrentView != ViewMode.Login) ResetToLogin();
            }
            // 在登录/注册表单时，错误显示在表单提示区
            if (CurrentView == ViewMode.Login)
            {
                FormError = msg ?? "操作失败";
            }
            StatusText = msg ?? "操作失败";
        });
    }

    private void OnStatusChanged(bool connected)
    {
        Ui(() => { Connected = connected; });
    }

    private static void Ui(Action action)
    {
        var app = Application.Current;
        if (app == null) return;
        var d = app.Dispatcher;
        if (d.HasShutdownStarted || d.HasShutdownFinished) return;
        try
        {
            if (d.CheckAccess()) action();
            else d.Invoke(action);
        }
        catch (OperationCanceledException) { /* 退出时调度器已关闭 */ }
    }
}
