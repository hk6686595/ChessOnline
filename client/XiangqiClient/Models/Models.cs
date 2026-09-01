namespace XiangqiClient.Models;

/// <summary>用户信息</summary>
public class UserInfo
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool IsGuest { get; set; }
    public int Rating { get; set; }
    public int Wins { get; set; }
    public int Losses { get; set; }
    public int Draws { get; set; }
    public string Avatar { get; set; } = "🐯";
}

/// <summary>房间内玩家席位</summary>
public class RoomPlayer
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool IsOwner { get; set; }
    public bool Ready { get; set; }
    public bool Online { get; set; }
}

/// <summary>坐标</summary>
public class Point2
{
    public int X { get; set; }
    public int Y { get; set; }
}

/// <summary>一步走子</summary>
public class Move2
{
    public Point2 From { get; set; } = new();
    public Point2 To { get; set; } = new();
}

/// <summary>棋谱中的一步（服务端 moves 数组元素）</summary>
public class MoveRecord
{
    public string Player { get; set; } = "";
    public Point2 From { get; set; } = new();
    public Point2 To { get; set; } = new();
    public string? Captured { get; set; }
    public string? Notation { get; set; }

    /// <summary>显示：第N手 红 炮八进二</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public string Display { get; set; } = "";
}

/// <summary>对局状态（服务端 s.game.* 推送的 game 字段）</summary>
public class GameState
{
    public string Type { get; set; } = "xiangqi";
    public int Cols { get; set; } = 9;
    public int Rows { get; set; } = 10;
    public string?[][]? Board { get; set; }
    public int Turn { get; set; }
    public List<GamePlayer> Players { get; set; } = new();
    public int MoveCount { get; set; }
    public List<MoveRecord> Moves { get; set; } = new();
    public int TimeLimit { get; set; } = 60;
    /// <summary>局时（秒，0=关闭）</summary>
    public int GameTime { get; set; }
    /// <summary>每人剩余局时毫秒（userId → ms）</summary>
    public Dictionary<string, long>? Clocks { get; set; }
    public long TurnStartedAt { get; set; }
    public Move2? LastMove { get; set; }
    public string? Check { get; set; }
    /// <summary>五子棋连珠高亮（服务端 winLine）</summary>
    public List<Point2>? WinLine { get; set; }
    public bool Over { get; set; }
    public string? WinnerId { get; set; }
    public bool IsDraw { get; set; }
    public string? Reason { get; set; }
}

/// <summary>对局玩家（红/黑）</summary>
public class GamePlayer
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
}

/// <summary>对局设置（服务端 room.config，房主在等待中可修改）</summary>
public class RoomConfig
{
    /// <summary>每步走子时限（秒）</summary>
    public int TimeLimit { get; set; } = 60;

    /// <summary>局时包干（秒，0=关闭仅用步时）</summary>
    public int GameTime { get; set; }

    /// <summary>先手方："owner"=房主先手，"opponent"=对方先手</summary>
    public string FirstMove { get; set; } = "owner";
}

/// <summary>房间视图（s.room.* 推送的 room 字段）</summary>
public class RoomInfo
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string GameType { get; set; } = "xiangqi";
    public string GameName { get; set; } = "中国象棋";
    public string Mode { get; set; } = "pvp"; // pvp | ai（人机）
    public bool HasPassword { get; set; }
    public string Status { get; set; } = "waiting";
    public string OwnerId { get; set; } = "";
    public int MaxPlayers { get; set; } = 2;
    public List<RoomPlayer> Players { get; set; } = new();
    public List<RoomPlayer> Spectators { get; set; } = new();
    public RoomConfig? Config { get; set; }
    public GameState? Game { get; set; }
}

/// <summary>房间列表项</summary>
public class RoomListItem
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string GameType { get; set; } = "xiangqi";
    public string GameName { get; set; } = "中国象棋";
    public bool HasPassword { get; set; }
    public string Status { get; set; } = "waiting";
    public int PlayerCount { get; set; }
    public int MaxPlayers { get; set; }
    public int SpectatorCount { get; set; }
    public string OwnerName { get; set; } = "";

    public string StatusText => Status == "playing" ? "对局中" : "等待中";
    public string Meta => $"{PlayerCount}/{MaxPlayers}";
    public string Lock => HasPassword ? "🔒" : "";
}

/// <summary>聊天消息</summary>
public class ChatMessage
{
    public string From { get; set; } = "";
    public string? FromId { get; set; }
    public string Text { get; set; } = "";
    public long Ts { get; set; }
    public string Scope { get; set; } = "lobby";

    /// <summary>是否系统消息（由 UI 填充）</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool IsSystem { get; set; }

    /// <summary>是否自己发送的消息（由 UI 填充）</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool IsMine { get; set; }

    /// <summary>消息时间（HH:mm）</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public string TimeText => DateTimeOffset.FromUnixTimeMilliseconds(Ts).ToLocalTime().ToString("HH:mm");

    public string Display
    {
        get
        {
            var time = DateTimeOffset.FromUnixTimeMilliseconds(Ts).ToLocalTime().ToString("HH:mm");
            return $"[{time}] {From}: {Text}";
        }
    }
}

/// <summary>排行榜条目</summary>
public class RankItem
{
    public int Rank { get; set; }
    public string Name { get; set; } = "";
    public int Rating { get; set; }
    public int Wins { get; set; }
    public int Losses { get; set; }
    public int Draws { get; set; }

    public string Medal => Rank switch { 1 => "🥇", 2 => "🥈", 3 => "🥉", _ => Rank.ToString() };
    public string Record => $"{Wins}胜/{Losses}负/{Draws}平";
}

/// <summary>服务端 s.error 错误</summary>
public class ServerError
{
    public string Code { get; set; } = "";
    public string Message { get; set; } = "";
}

/// <summary>对局中的玩家（历史记录）</summary>
public class MatchPlayer
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public int Rating { get; set; }
}

/// <summary>个人历史对局（服务端 buildMatchView 结果）</summary>
public class MatchRecord
{
    public int Id { get; set; }
    public long Ts { get; set; }
    public string GameType { get; set; } = "xiangqi";
    public string GameName => GameType == "gomoku" ? "五子棋" : "中国象棋";
    public string Result { get; set; } = "平局"; // 胜 / 负 / 平局
    public int MoveCount { get; set; }
    public string? Reason { get; set; }
    public MatchPlayer? Opponent { get; set; }
    public List<MatchPlayer> Players { get; set; } = new();

    /// <summary>显示文本：08-19 13:04 胜 对手名（12 手）原因</summary>
    public string Display
    {
        get
        {
            var time = DateTimeOffset.FromUnixTimeMilliseconds(Ts).ToLocalTime().ToString("MM-dd HH:mm");
            var opp = Opponent?.Name ?? "未知";
            var mark = Result switch
            {
                "胜" => "✅ 胜",
                "负" => "❌ 负",
                _ => "➖ 平局",
            };
            return $"[{time}] {mark} {GameName} vs {opp}（{MoveCount} 手）{(Reason ?? "")}";
        }
    }
}

/// <summary>对局详情（含完整棋谱，用于复盘）</summary>
public class MatchDetail
{
    public int Id { get; set; }
    public long Ts { get; set; }
    public string GameType { get; set; } = "xiangqi";
    public List<MatchPlayer> Players { get; set; } = new();
    public string? WinnerId { get; set; }
    public bool IsDraw { get; set; }
    public string? Reason { get; set; }
    public int MoveCount { get; set; }
    public List<MoveRecord> Moves { get; set; } = new();
}

/// <summary>好友（已是好友关系）</summary>
public class FriendInfo
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Avatar { get; set; } = "🐯";
    public bool Online { get; set; }

    /// <summary>未读私聊消息数（由 ViewModel 更新）</summary>
    public int UnreadCount { get; set; }

    public string StatusText => Online ? "🟢 在线" : "⚪ 离线";
    public bool HasUnread => UnreadCount > 0;
}

/// <summary>好友请求（incoming=别人发给我的；outgoing=我发出的）</summary>
public class FriendRequestInfo
{
    public string Id { get; set; } = "";   // 对方 userId
    public string Name { get; set; } = "";
}

/// <summary>收到的定向对战邀请</summary>
public class InviteInfo
{
    public string FromId { get; set; } = "";
    public string FromName { get; set; } = "";
    public string RoomId { get; set; } = "";
    public string RoomName { get; set; } = "";
    public string GameType { get; set; } = "xiangqi";
    public string GameName => GameType == "gomoku" ? "五子棋" : "中国象棋";
    public string Password { get; set; } = "";
}
