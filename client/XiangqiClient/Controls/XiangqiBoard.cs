using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using XiangqiClient.Models;
using XiangqiClient.Services;

namespace XiangqiClient.Controls;

/// <summary>
/// 中国象棋棋盘控件：Canvas 绘制 9×10 棋盘与棋子，支持点击选子/走子。
/// 通过依赖属性绑定 Game / SelectedFrom / BlackPerspective，点击触发 CellClicked 事件。
/// BlackPerspective=true（黑方视角）时棋盘整体旋转 180°：黑方棋子显示在屏幕下方，
/// 点击坐标自动还原为服务器棋盘坐标，游戏逻辑不受影响。
/// 走子时棋子沿路径滑行落地（类似天天象棋），落子音效在棋子落地时播放。
/// </summary>
public class XiangqiBoard : UserControl
{
    public const int Cell = 60;
    public const int Pad = 44;
    public const int PieceR = 26;

    private static readonly Color LastMoveColor = Color.FromRgb(0xC0, 0x39, 0x2B);
    private static readonly Color HintColor = Color.FromRgb(0x15, 0x7A, 0xD4);
    private static readonly Color SelectColor = Color.FromRgb(0x2E, 0xA8, 0x4E);

    private readonly Canvas _canvas;

    private bool _animating;
    private Point2? _skipTo;
    private string? _ghostCode;
    private UIElement? _flying;
    private int _animGen;
    private bool _landCaptured;
    private string? _landCheck;
    private bool _landOver;
    private bool _landIsDraw;
    private string? _landReason;
    private int _animMoveCount = int.MinValue;
    private int _animFromX, _animFromY, _animToX, _animToY;

    public static readonly DependencyProperty GameProperty =
        DependencyProperty.Register(nameof(Game), typeof(GameState), typeof(XiangqiBoard),
            new PropertyMetadata(null, (d, e) => ((XiangqiBoard)d).OnGameChanged(e.OldValue as GameState, e.NewValue as GameState)));

    public static readonly DependencyProperty SelectedFromProperty =
        DependencyProperty.Register(nameof(SelectedFrom), typeof(Point2), typeof(XiangqiBoard),
            new PropertyMetadata(null, (d, _) => ((XiangqiBoard)d).OnOverlayChanged()));

    public static readonly DependencyProperty BlackPerspectiveProperty =
        DependencyProperty.Register(nameof(BlackPerspective), typeof(bool), typeof(XiangqiBoard),
            new PropertyMetadata(false, (d, _) => ((XiangqiBoard)d).OnPerspectiveChanged()));

    public static readonly DependencyProperty HintProperty =
        DependencyProperty.Register(nameof(Hint), typeof(Move2), typeof(XiangqiBoard),
            new PropertyMetadata(null, (d, _) => ((XiangqiBoard)d).OnOverlayChanged()));

    public GameState? Game
    {
        get => (GameState?)GetValue(GameProperty);
        set => SetValue(GameProperty, value);
    }

    public Point2? SelectedFrom
    {
        get => (Point2?)GetValue(SelectedFromProperty);
        set => SetValue(SelectedFromProperty, value);
    }

    /// <summary>黑方视角：棋盘上下镜像，黑方棋子显示在屏幕下方（点击坐标同步反转）</summary>
    public bool BlackPerspective
    {
        get => (bool)GetValue(BlackPerspectiveProperty);
        set => SetValue(BlackPerspectiveProperty, value);
    }

    /// <summary>走法提示（金色虚线框标出起点与终点）</summary>
    public Move2? Hint
    {
        get => (Move2?)GetValue(HintProperty);
        set => SetValue(HintProperty, value);
    }

    /// <summary>点击棋盘格子（服务器棋盘坐标，黑方视角会自动还原）</summary>
    public event Action<Point2>? CellClicked;

    public XiangqiBoard()
    {
        _canvas = new Canvas
        {
            Width = Pad * 2 + 8 * Cell,
            Height = Pad * 2 + 9 * Cell,
            Background = new SolidColorBrush(Color.FromRgb(0xE8, 0xC9, 0x7E)),
        };
        Content = _canvas;
        MouseLeftButtonDown += OnMouseClick;
        Unloaded += (_, _) => StopMoveAnimation();
        Redraw();
    }

    /// <summary>棋盘 x → 屏幕 X（黑方视角水平镜像：8 - x）</summary>
    private double PX(double x) => Pad + (BlackPerspective ? 8 - x : x) * Cell;

    /// <summary>棋盘 y → 屏幕 Y（黑方视角垂直镜像：9 - y，黑方在屏幕下方）</summary>
    private double PY(double y) => Pad + (BlackPerspective ? 9 - y : y) * Cell;

    private void OnMouseClick(object sender, MouseButtonEventArgs e)
    {
        if (_animating || Game?.Board == null) return;
        var pos = e.GetPosition(_canvas);
        int cx = (int)Math.Round((pos.X - Pad) / Cell);
        int cy = (int)Math.Round((pos.Y - Pad) / Cell);
        // 黑方视角：把屏幕坐标还原为服务器棋盘坐标，保证走子逻辑不变
        if (BlackPerspective)
        {
            cx = 8 - cx;
            cy = 9 - cy;
        }
        if (cx < 0 || cx > 8 || cy < 0 || cy > 9) return;
        CellClicked?.Invoke(new Point2 { X = cx, Y = cy });
    }

    private void OnOverlayChanged()
    {
        if (_animating) return;
        Redraw();
    }

    private void OnPerspectiveChanged()
    {
        StopMoveAnimation();
        Redraw();
    }

    private void OnGameChanged(GameState? oldGame, GameState? newGame)
    {
        if (_animating && IsSameAnimatedMove(newGame))
        {
            // 同一手的后续同步（如 GAME_OVER / room.update）不打断滑行
            if (newGame != null)
            {
                _landOver = newGame.Over;
                _landIsDraw = newGame.IsDraw;
                _landReason = newGame.Reason;
                _landCheck = newGame.Check;
            }
            return;
        }

        StopMoveAnimation();
        if (ShouldAnimate(oldGame, newGame))
            StartMoveAnimation(oldGame, newGame!);
        else
            Redraw();
    }

    private static bool ShouldAnimate(GameState? oldGame, GameState? newGame)
    {
        if (newGame == null || string.Equals(newGame.Type, "gomoku", StringComparison.OrdinalIgnoreCase))
            return false;
        if (oldGame == null) return false;
        var mv = newGame.LastMove;
        if (mv?.From == null || mv.To == null) return false;
        if (mv.From.X == mv.To.X && mv.From.Y == mv.To.Y) return false;
        var addedMoves = newGame.Moves.Count - oldGame.Moves.Count;
        var addedCount = newGame.MoveCount - oldGame.MoveCount;
        if (addedMoves != 1 && addedCount != 1) return false;
        return !string.IsNullOrEmpty(GetPiece(newGame, mv.To));
    }

    private bool IsSameAnimatedMove(GameState? game)
    {
        if (!_animating || game?.LastMove?.From == null || game.LastMove.To == null) return false;
        if (game.MoveCount != _animMoveCount && game.Moves.Count != _animMoveCount) return false;
        var mv = game.LastMove;
        return mv.From.X == _animFromX && mv.From.Y == _animFromY
            && mv.To.X == _animToX && mv.To.Y == _animToY;
    }

    private void StartMoveAnimation(GameState? oldGame, GameState newGame)
    {
        var mv = newGame.LastMove!;
        var code = GetPiece(newGame, mv.To);
        if (string.IsNullOrEmpty(code))
        {
            Redraw();
            return;
        }

        _animFromX = mv.From.X;
        _animFromY = mv.From.Y;
        _animToX = mv.To.X;
        _animToY = mv.To.Y;
        _animMoveCount = newGame.MoveCount > 0 ? newGame.MoveCount : newGame.Moves.Count;
        _landCaptured = oldGame != null && !string.IsNullOrEmpty(GetPiece(oldGame, mv.To));
        _ghostCode = _landCaptured ? GetPiece(oldGame!, mv.To) : null;
        _landCheck = newGame.Check;
        _landOver = newGame.Over;
        _landIsDraw = newGame.IsDraw;
        _landReason = newGame.Reason;
        _skipTo = mv.To;
        _animating = true;

        Redraw();

        var visual = CreatePieceVisual(code);
        visual.RenderTransformOrigin = new Point(0.5, 0.5);
        var scale = new ScaleTransform(1, 1);
        visual.RenderTransform = scale;
        Panel.SetZIndex(visual, 20);

        var fromL = PX(mv.From.X) - PieceR;
        var fromT = PY(mv.From.Y) - PieceR;
        var toL = PX(mv.To.X) - PieceR;
        var toT = PY(mv.To.Y) - PieceR;
        Canvas.SetLeft(visual, fromL);
        Canvas.SetTop(visual, fromT);
        _canvas.Children.Add(visual);

        var ms = AnimDurationMs(mv.From, mv.To);
        var duration = TimeSpan.FromMilliseconds(ms);
        var ease = new CubicEase { EasingMode = EasingMode.EaseOut };

        var ax = new DoubleAnimation(fromL, toL, duration) { EasingFunction = ease, FillBehavior = FillBehavior.HoldEnd };
        var ay = new DoubleAnimation(fromT, toT, duration) { EasingFunction = ease, FillBehavior = FillBehavior.HoldEnd };
        var lift = new DoubleAnimationUsingKeyFrames { Duration = duration, FillBehavior = FillBehavior.HoldEnd };
        lift.KeyFrames.Add(new EasingDoubleKeyFrame(1.14, KeyTime.FromPercent(0.32), new QuadraticEase { EasingMode = EasingMode.EaseOut }));
        lift.KeyFrames.Add(new EasingDoubleKeyFrame(1.0, KeyTime.FromPercent(1.0), new QuadraticEase { EasingMode = EasingMode.EaseIn }));
        var liftY = (DoubleAnimationUsingKeyFrames)lift.Clone();

        _flying = visual;
        var gen = ++_animGen;
        ax.Completed += (_, _) => OnMoveAnimCompleted(gen);
        visual.BeginAnimation(Canvas.LeftProperty, ax);
        visual.BeginAnimation(Canvas.TopProperty, ay);
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, lift);
        scale.BeginAnimation(ScaleTransform.ScaleYProperty, liftY);
    }

    private static int AnimDurationMs(Point2 from, Point2 to)
    {
        var dx = from.X - to.X;
        var dy = from.Y - to.Y;
        var dist = Math.Sqrt(dx * dx + dy * dy);
        return (int)Math.Clamp(200 + dist * 24, 220, 320);
    }

    private void OnMoveAnimCompleted(int gen)
    {
        if (gen != _animGen) return;
        StopMoveAnimation();
        Redraw();
        PlayLandingSound();
    }

    private void StopMoveAnimation()
    {
        _animGen++;
        if (_flying != null)
        {
            _flying.BeginAnimation(Canvas.LeftProperty, null);
            _flying.BeginAnimation(Canvas.TopProperty, null);
            if (_flying.RenderTransform is ScaleTransform st)
            {
                st.BeginAnimation(ScaleTransform.ScaleXProperty, null);
                st.BeginAnimation(ScaleTransform.ScaleYProperty, null);
            }
            _flying = null;
        }
        _animating = false;
        _skipTo = null;
        _ghostCode = null;
    }

    private void PlayLandingSound()
    {
        if (_landOver && !_landIsDraw
            && (_landReason?.Contains("绝杀") == true || _landReason?.Contains("吃掉对方") == true))
        {
            SoundService.PlayMate(_landCaptured);
            return;
        }
        SoundService.PlayMove(_landCaptured, check: !string.IsNullOrEmpty(_landCheck));
    }

    private static string? GetPiece(GameState g, Point2 c)
        => g.Board != null && c.Y >= 0 && c.Y < g.Board.Length && g.Board[c.Y] != null
           && c.X >= 0 && c.X < g.Board[c.Y].Length
            ? g.Board[c.Y][c.X]
            : null;

    // ---------------- 绘制 ----------------

    private void Redraw()
    {
        _canvas.Children.Clear();
        var preview = Game?.Board == null;
        var board = preview ? PreviewBoard : Game!.Board;

        var pen = new Pen(new SolidColorBrush(Color.FromRgb(0x6B, 0x4A, 0x20)), 1.6);
        var thinPen = new Pen(new SolidColorBrush(Color.FromRgb(0x6B, 0x4A, 0x20)), 1.2);

        // 横线（10 条）
        for (int y = 0; y < 10; y++)
            _canvas.Children.Add(new Line { X1 = PX(0), Y1 = PY(y), X2 = PX(8), Y2 = PY(y), Stroke = pen.Brush, StrokeThickness = pen.Thickness });

        // 纵线（河界断开：上半 y0-4，下半 y5-9）
        for (int x = 0; x < 9; x++)
        {
            _canvas.Children.Add(new Line { X1 = PX(x), Y1 = PY(0), X2 = PX(x), Y2 = PY(4), Stroke = pen.Brush, StrokeThickness = pen.Thickness });
            _canvas.Children.Add(new Line { X1 = PX(x), Y1 = PY(5), X2 = PX(x), Y2 = PY(9), Stroke = pen.Brush, StrokeThickness = pen.Thickness });
        }

        // 九宫斜线
        DrawDiag(3, 0, 5, 2, thinPen);   // 黑九宫
        DrawDiag(5, 0, 3, 2, thinPen);
        DrawDiag(3, 7, 5, 9, thinPen);   // 红九宫
        DrawDiag(5, 7, 3, 9, thinPen);

        // 河界文字（黑方视角时位置同步镜像，文字保持正立可读）
        AddText("楚　河", 2.4, 4.6, 26, Brushes.DarkRed, FontWeights.Bold);
        AddText("汉　界", 5.6, 4.6, 26, Brushes.DarkRed, FontWeights.Bold);

        // 上/下边序号：上边（黑方）1-9 从左到右，下边（红方）1-9 从右到左。
        // 黑方视角镜像后按服务器坐标换算，双方读数始终从各自右侧起数。
        DrawEdgeNumbers(pen.Brush);

        // 炮位 / 兵位标记
        DrawMark(1, 2); DrawMark(7, 2);
        DrawMark(1, 7); DrawMark(7, 7);
        for (int x = 0; x < 9; x += 2)
        {
            DrawMark(x, 3); DrawMark(x, 6);
        }

        if (board == null) return;
        for (int y = 0; y < 10 && y < board.Length; y++)
        {
            if (board[y] == null) continue;
            for (int x = 0; x < 9 && x < board[y].Length; x++)
            {
                var code = board[y][x];
                if (string.IsNullOrEmpty(code)) continue;
                if (_animating && _skipTo != null && x == _skipTo.X && y == _skipTo.Y)
                    continue;
                DrawPiece(x, y, code!);
            }
        }

        if (_animating && !string.IsNullOrEmpty(_ghostCode) && _skipTo != null)
            DrawPiece(_skipTo.X, _skipTo.Y, _ghostCode, 0.42, showCheck: false);

        if (preview)
        {
            DrawWaitingBanner();
            return;
        }

        // 走子 / 选中 / 提示：只保留四角框，避免叠色块和闪圈
        if (Game!.LastMove != null)
        {
            DrawCornerBrackets(Game.LastMove.From, LastMoveColor);
            DrawCornerBrackets(Game.LastMove.To, LastMoveColor);
        }
        if (SelectedFrom != null)
            DrawCornerBrackets(SelectedFrom, SelectColor);
        if (Hint?.From != null && Hint.To != null)
        {
            DrawHintLine(Hint.From, Hint.To, HintColor);
            DrawCornerBrackets(Hint.From, HintColor);
            DrawCornerBrackets(Hint.To, HintColor);
        }
    }

    private void DrawDiag(int x1, int y1, int x2, int y2, Pen pen)
        => _canvas.Children.Add(new Line
        {
            X1 = PX(x1), Y1 = PY(y1), X2 = PX(x2), Y2 = PY(y2),
            Stroke = pen.Brush, StrokeThickness = pen.Thickness,
        });

    private void AddText(string text, double cx, double cy, double size, Brush brush, FontWeight weight)
    {
        var tb = new TextBlock
        {
            Text = text,
            FontSize = size,
            FontFamily = new FontFamily("楷体"),
            Foreground = brush,
            FontWeight = weight,
        };
        tb.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        Canvas.SetLeft(tb, PX(cx) - tb.DesiredSize.Width / 2);
        Canvas.SetTop(tb, PY(cy) - tb.DesiredSize.Height / 2);
        _canvas.Children.Add(tb);
    }

    /// <summary>
    /// 上/下边路号（参考标准棋盘：红方用中文数字、黑方用阿拉伯数字）：
    /// 上边（黑方）：1-9 从左到右（黑方从自己右侧起数，屏幕即从左往右）；
    /// 下边（红方）：九-一 从左到右（红方从自己右侧起数，屏幕即 一 在右侧）。
    /// 黑方视角（BlackPerspective）时棋盘整体 180° 旋转，PY 镜像会让上下边的
    /// 标签互换屏幕位置，从而自动保持"各方读数从自己右侧起"的标准读法。
    /// </summary>
    private static readonly string[] CnDigits = { "一", "二", "三", "四", "五", "六", "七", "八", "九" };

    private void DrawEdgeNumbers(Brush brush)
    {
        for (int x = 0; x < 9; x++)
        {
            AddText((x + 1).ToString(), x, -0.5, 17, brush, FontWeights.Bold);  // 上边：黑方 1-9（阿拉伯数字）
            AddText(CnDigits[8 - x], x, 9.5, 17, brush, FontWeights.Bold);      // 下边：红方 九-一（中文数字）
        }
    }

    private void DrawMark(int x, int y)
    {
        var cx = PX(x);
        var cy = PY(y);
        var c = 5.0;
        var brush = new SolidColorBrush(Color.FromRgb(0x6B, 0x4A, 0x20));
        _canvas.Children.Add(new Line { X1 = cx - c, Y1 = cy, X2 = cx + c, Y2 = cy, Stroke = brush, StrokeThickness = 1.2 });
        _canvas.Children.Add(new Line { X1 = cx, Y1 = cy - c, X2 = cx, Y2 = cy + c, Stroke = brush, StrokeThickness = 1.2 });
    }

    private void DrawCornerBrackets(Point2? p, Color color)
    {
        if (p == null) return;
        double cx = PX(p.X), cy = PY(p.Y);
        const double gap = 24;
        const double arm = 10;
        const double thickness = 2.8;
        var brush = new SolidColorBrush(color);
        DrawBracketSet(cx, cy, gap, arm, brush, thickness);
    }

    private void DrawBracketSet(double cx, double cy, double gap, double arm, Brush brush, double thickness)
    {
        double L = cx - gap, R = cx + gap, T = cy - gap, B = cy + gap;
        AddCapLine(L, T, L + arm, T, brush, thickness);
        AddCapLine(L, T, L, T + arm, brush, thickness);
        AddCapLine(R, T, R - arm, T, brush, thickness);
        AddCapLine(R, T, R, T + arm, brush, thickness);
        AddCapLine(L, B, L + arm, B, brush, thickness);
        AddCapLine(L, B, L, B - arm, brush, thickness);
        AddCapLine(R, B, R - arm, B, brush, thickness);
        AddCapLine(R, B, R, B - arm, brush, thickness);
    }

    private void AddCapLine(double x1, double y1, double x2, double y2, Brush brush, double thickness)
    {
        _canvas.Children.Add(new Line
        {
            X1 = x1, Y1 = y1, X2 = x2, Y2 = y2,
            Stroke = brush,
            StrokeThickness = thickness,
            StrokeStartLineCap = PenLineCap.Square,
            StrokeEndLineCap = PenLineCap.Square,
            IsHitTestVisible = false,
        });
    }

    private void DrawHintLine(Point2 from, Point2 to, Color color)
    {
        _canvas.Children.Add(new Line
        {
            X1 = PX(from.X), Y1 = PY(from.Y),
            X2 = PX(to.X), Y2 = PY(to.Y),
            Stroke = new SolidColorBrush(color),
            StrokeThickness = 2,
            StrokeDashArray = new DoubleCollection { 4, 3 },
            Opacity = 0.75,
            IsHitTestVisible = false,
        });
    }

    private static readonly Dictionary<string, string> Names = new()
    {
        ["rk"] = "帅", ["ra"] = "仕", ["re"] = "相", ["rh"] = "马", ["rr"] = "车", ["rc"] = "炮", ["rp"] = "兵",
        ["bk"] = "将", ["ba"] = "士", ["be"] = "象", ["bh"] = "马", ["br"] = "车", ["bc"] = "炮", ["bp"] = "卒",
    };

    /// <summary>开局前预览用的标准开局摆子（红下黑上）</summary>
    private static readonly string?[][] PreviewBoard = CreatePreviewBoard();

    private static string?[][] CreatePreviewBoard()
    {
        var board = new string?[10][];
        for (int i = 0; i < 10; i++) board[i] = new string?[9];
        board[0][0] = "br"; board[0][1] = "bh"; board[0][2] = "be"; board[0][3] = "ba"; board[0][4] = "bk";
        board[0][5] = "ba"; board[0][6] = "be"; board[0][7] = "bh"; board[0][8] = "br";
        board[2][1] = "bc"; board[2][7] = "bc";
        board[3][0] = "bp"; board[3][2] = "bp"; board[3][4] = "bp"; board[3][6] = "bp"; board[3][8] = "bp";
        board[9][0] = "rr"; board[9][1] = "rh"; board[9][2] = "re"; board[9][3] = "ra"; board[9][4] = "rk";
        board[9][5] = "ra"; board[9][6] = "re"; board[9][7] = "rh"; board[9][8] = "rr";
        board[7][1] = "rc"; board[7][7] = "rc";
        board[6][0] = "rp"; board[6][2] = "rp"; board[6][4] = "rp"; board[6][6] = "rp"; board[6][8] = "rp";
        return board;
    }

    private void DrawWaitingBanner()
    {
        const double w = 168;
        const double h = 38;
        var banner = new Border
        {
            Width = w,
            Height = h,
            CornerRadius = new CornerRadius(8),
            Background = new SolidColorBrush(Color.FromArgb(220, 0x1B, 0x24, 0x38)),
            BorderBrush = new SolidColorBrush(Color.FromRgb(0xC0, 0x39, 0x2B)),
            BorderThickness = new Thickness(1.4),
            IsHitTestVisible = false,
            Child = new TextBlock
            {
                Text = "等待开局",
                FontSize = 18,
                FontFamily = new FontFamily("楷体"),
                FontWeight = FontWeights.Bold,
                Foreground = new SolidColorBrush(Color.FromRgb(0xFB, 0xF3, 0xDF)),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            },
        };
        Canvas.SetLeft(banner, PX(4) - w / 2);
        Canvas.SetTop(banner, PY(4.5) - h / 2);
        _canvas.Children.Add(banner);
    }

    private Canvas CreatePieceVisual(string code)
    {
        bool red = code.Length > 0 && code[0] == 'r';
        var root = new Canvas
        {
            Width = PieceR * 2,
            Height = PieceR * 2,
            IsHitTestVisible = false,
        };
        var ellipse = new Ellipse
        {
            Width = PieceR * 2,
            Height = PieceR * 2,
            Fill = new SolidColorBrush(Color.FromRgb(0xFB, 0xF3, 0xDF)),
            Stroke = red ? new SolidColorBrush(Color.FromRgb(0xC0, 0x39, 0x2B)) : new SolidColorBrush(Color.FromRgb(0x2C, 0x2C, 0x2C)),
            StrokeThickness = 2,
            IsHitTestVisible = false,
        };
        Canvas.SetLeft(ellipse, 0);
        Canvas.SetTop(ellipse, 0);
        root.Children.Add(ellipse);

        var name = Names.TryGetValue(code, out var n) ? n : code;
        var tb = new TextBlock
        {
            Text = name,
            FontSize = 30,
            FontFamily = new FontFamily("楷体"),
            FontWeight = FontWeights.Bold,
            Foreground = red ? new SolidColorBrush(Color.FromRgb(0xC0, 0x39, 0x2B)) : new SolidColorBrush(Color.FromRgb(0x2C, 0x2C, 0x2C)),
            IsHitTestVisible = false,
        };
        tb.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        Canvas.SetLeft(tb, PieceR - tb.DesiredSize.Width / 2);
        Canvas.SetTop(tb, PieceR - tb.DesiredSize.Height / 2);
        root.Children.Add(tb);
        return root;
    }

    private void DrawPiece(int x, int y, string code, double opacity = 1, bool showCheck = true)
    {
        var visual = CreatePieceVisual(code);
        visual.Opacity = opacity;
        Canvas.SetLeft(visual, PX(x) - PieceR);
        Canvas.SetTop(visual, PY(y) - PieceR);
        _canvas.Children.Add(visual);

        // 被将军方的老将加红圈警示
        if (showCheck && Game?.Check is { Length: > 0 } checkColor && code.Length > 1 && code[1] == 'k' && code[0] == checkColor[0])
        {
            var cx = PX(x);
            var cy = PY(y);
            var ring = new Ellipse
            {
                Width = PieceR * 2 + 8,
                Height = PieceR * 2 + 8,
                Stroke = new SolidColorBrush(Color.FromRgb(0xFF, 0x33, 0x33)),
                StrokeThickness = 3,
                IsHitTestVisible = false,
                Opacity = opacity,
            };
            Canvas.SetLeft(ring, cx - PieceR - 4);
            Canvas.SetTop(ring, cy - PieceR - 4);
            _canvas.Children.Add(ring);
        }
    }
}
