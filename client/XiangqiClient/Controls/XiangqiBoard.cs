using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using XiangqiClient.Models;

namespace XiangqiClient.Controls;

/// <summary>
/// 中国象棋棋盘控件：Canvas 绘制 9×10 棋盘与棋子，支持点击选子/走子。
/// 通过依赖属性绑定 Game / SelectedFrom / BlackPerspective，点击触发 CellClicked 事件。
/// BlackPerspective=true（黑方视角）时棋盘整体旋转 180°：黑方棋子显示在屏幕下方，
/// 点击坐标自动还原为服务器棋盘坐标，游戏逻辑不受影响。
/// </summary>
public class XiangqiBoard : UserControl
{
    public const int Cell = 60;
    public const int Pad = 44;
    public const int PieceR = 26;

    private readonly Canvas _canvas;

    public static readonly DependencyProperty GameProperty =
        DependencyProperty.Register(nameof(Game), typeof(GameState), typeof(XiangqiBoard),
            new PropertyMetadata(null, (d, _) => ((XiangqiBoard)d).Redraw()));

    public static readonly DependencyProperty SelectedFromProperty =
        DependencyProperty.Register(nameof(SelectedFrom), typeof(Point2), typeof(XiangqiBoard),
            new PropertyMetadata(null, (d, _) => ((XiangqiBoard)d).Redraw()));

    public static readonly DependencyProperty BlackPerspectiveProperty =
        DependencyProperty.Register(nameof(BlackPerspective), typeof(bool), typeof(XiangqiBoard),
            new PropertyMetadata(false, (d, _) => ((XiangqiBoard)d).Redraw()));

    public static readonly DependencyProperty HintProperty =
        DependencyProperty.Register(nameof(Hint), typeof(Move2), typeof(XiangqiBoard),
            new PropertyMetadata(null, (d, _) => ((XiangqiBoard)d).Redraw()));

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
    }

    /// <summary>棋盘 x → 屏幕 X（黑方视角水平镜像：8 - x）</summary>
    private double PX(double x) => Pad + (BlackPerspective ? 8 - x : x) * Cell;

    /// <summary>棋盘 y → 屏幕 Y（黑方视角垂直镜像：9 - y，黑方在屏幕下方）</summary>
    private double PY(double y) => Pad + (BlackPerspective ? 9 - y : y) * Cell;

    private void OnMouseClick(object sender, MouseButtonEventArgs e)
    {
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

    // ---------------- 绘制 ----------------

    private void Redraw()
    {
        _canvas.Children.Clear();
        if (Game == null) return;

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

        // 最后一步标记
        if (Game.LastMove != null)
        {
            MarkCell(Game.LastMove.From, Brushes.Orange);
            MarkCell(Game.LastMove.To, Brushes.Gold);
        }

        // 选中高亮
        if (SelectedFrom != null)
        {
            MarkCell(SelectedFrom, Brushes.LimeGreen, 5);
        }

        // 棋子
        var board = Game.Board;
        if (board == null) return;
        for (int y = 0; y < 10 && y < board.Length; y++)
        {
            if (board[y] == null) continue;
            for (int x = 0; x < 9 && x < board[y].Length; x++)
            {
                var code = board[y][x];
                if (string.IsNullOrEmpty(code)) continue;
                DrawPiece(x, y, code!);
            }
        }

        // 提示走法：金色虚线框（绘制在棋子之上保证可见）
        if (Hint?.From != null)
        {
            DrawHintMark(Hint.From);
            if (Hint.To != null && (Hint.To.X != Hint.From.X || Hint.To.Y != Hint.From.Y))
                DrawHintMark(Hint.To);
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

    private void MarkCell(Point2? p, Brush brush, double thickness = 4)
    {
        var rect = new Rectangle
        {
            Width = Cell - 4,
            Height = Cell - 4,
            Stroke = brush,
            StrokeThickness = thickness,
            RadiusX = 6,
            RadiusY = 6,
            IsHitTestVisible = false,
        };
        Canvas.SetLeft(rect, PX(p.X) - rect.Width / 2);
        Canvas.SetTop(rect, PY(p.Y) - rect.Height / 2);
        _canvas.Children.Add(rect);
    }

    /// <summary>提示走法标记：金色虚线圆角框</summary>
    private void DrawHintMark(Point2 p)
    {
        var rect = new Rectangle
        {
            Width = Cell - 6,
            Height = Cell - 6,
            Stroke = new SolidColorBrush(Color.FromRgb(0xFF, 0xC1, 0x07)),
            StrokeThickness = 4,
            StrokeDashArray = new DoubleCollection { 3, 2 },
            RadiusX = 9,
            RadiusY = 9,
            IsHitTestVisible = false,
        };
        Canvas.SetLeft(rect, PX(p.X) - rect.Width / 2);
        Canvas.SetTop(rect, PY(p.Y) - rect.Height / 2);
        _canvas.Children.Add(rect);
    }

    private static readonly Dictionary<string, string> Names = new()
    {
        ["rk"] = "帅", ["ra"] = "仕", ["re"] = "相", ["rh"] = "马", ["rr"] = "车", ["rc"] = "炮", ["rp"] = "兵",
        ["bk"] = "将", ["ba"] = "士", ["be"] = "象", ["bh"] = "马", ["br"] = "车", ["bc"] = "炮", ["bp"] = "卒",
    };

    private void DrawPiece(int x, int y, string code)
    {
        var cx = PX(x);
        var cy = PY(y);
        bool red = code[0] == 'r';

        var ellipse = new Ellipse
        {
            Width = PieceR * 2,
            Height = PieceR * 2,
            Fill = new SolidColorBrush(Color.FromRgb(0xFB, 0xF3, 0xDF)),
            Stroke = red ? new SolidColorBrush(Color.FromRgb(0xC0, 0x39, 0x2B)) : new SolidColorBrush(Color.FromRgb(0x2C, 0x2C, 0x2C)),
            StrokeThickness = 2,
            IsHitTestVisible = false,
        };
        Canvas.SetLeft(ellipse, cx - PieceR);
        Canvas.SetTop(ellipse, cy - PieceR);
        _canvas.Children.Add(ellipse);

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
        Canvas.SetLeft(tb, cx - tb.DesiredSize.Width / 2);
        Canvas.SetTop(tb, cy - tb.DesiredSize.Height / 2);
        _canvas.Children.Add(tb);

        // 被将军方的老将加红圈警示
        if (Game?.Check is { Length: > 0 } checkColor && code[1] == 'k' && code[0] == checkColor[0])
        {
            var ring = new Ellipse
            {
                Width = PieceR * 2 + 8,
                Height = PieceR * 2 + 8,
                Stroke = new SolidColorBrush(Color.FromRgb(0xFF, 0x33, 0x33)),
                StrokeThickness = 3,
                IsHitTestVisible = false,
            };
            Canvas.SetLeft(ring, cx - PieceR - 4);
            Canvas.SetTop(ring, cy - PieceR - 4);
            _canvas.Children.Add(ring);
        }
    }
}
