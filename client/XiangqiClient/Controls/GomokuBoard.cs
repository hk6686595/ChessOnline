using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using XiangqiClient.Models;

namespace XiangqiClient.Controls;

/// <summary>
/// 五子棋棋盘：Canvas 绘制 15×15 交叉点，点击空点落子。
/// 通过 Game 依赖属性绑定对局状态；点击触发 CellClicked（服务器坐标）。
/// </summary>
public class GomokuBoard : UserControl
{
    public const int Size = 15;
    public const double Cell = 36;
    public const double Pad = 32;
    public const double StoneR = 15;

    private readonly Canvas _canvas;

    public static readonly DependencyProperty GameProperty =
        DependencyProperty.Register(nameof(Game), typeof(GameState), typeof(GomokuBoard),
            new PropertyMetadata(null, (d, _) => ((GomokuBoard)d).Redraw()));

    public GameState? Game
    {
        get => (GameState?)GetValue(GameProperty);
        set => SetValue(GameProperty, value);
    }

    public event Action<Point2>? CellClicked;

    public GomokuBoard()
    {
        var dim = Pad * 2 + (Size - 1) * Cell;
        _canvas = new Canvas
        {
            Width = dim,
            Height = dim,
            Background = new SolidColorBrush(Color.FromRgb(0xDC, 0xB3, 0x5C)),
        };
        Content = _canvas;
        MouseLeftButtonDown += OnMouseClick;
        Redraw();
    }

    private int Cols => Game is { Cols: > 0 } ? Game.Cols : Size;
    private int Rows => Game is { Rows: > 0 } ? Game.Rows : Size;

    private double PX(double x) => Pad + x * Cell;
    private double PY(double y) => Pad + y * Cell;

    private void OnMouseClick(object sender, MouseButtonEventArgs e)
    {
        var pos = e.GetPosition(_canvas);
        int cx = (int)Math.Round((pos.X - Pad) / Cell);
        int cy = (int)Math.Round((pos.Y - Pad) / Cell);
        if (cx < 0 || cy < 0 || cx >= Cols || cy >= Rows) return;
        CellClicked?.Invoke(new Point2 { X = cx, Y = cy });
    }

    private void Redraw()
    {
        _canvas.Children.Clear();
        int cols = Cols;
        int rows = Rows;
        var line = new SolidColorBrush(Color.FromRgb(0x5A, 0x3A, 0x14));
        var dim = new SolidColorBrush(Color.FromRgb(0x6B, 0x4A, 0x20));

        for (int i = 0; i < rows; i++)
        {
            _canvas.Children.Add(new Line
            {
                X1 = PX(0), Y1 = PY(i), X2 = PX(cols - 1), Y2 = PY(i),
                Stroke = line, StrokeThickness = 1.3,
            });
        }
        for (int i = 0; i < cols; i++)
        {
            _canvas.Children.Add(new Line
            {
                X1 = PX(i), Y1 = PY(0), X2 = PX(i), Y2 = PY(rows - 1),
                Stroke = line, StrokeThickness = 1.3,
            });
        }

        // 星位
        int[] stars = cols == 15 ? new[] { 3, 7, 11 } : new[] { cols / 2 };
        foreach (var sx in stars)
        foreach (var sy in stars)
            DrawStar(sx, sy);

        // 坐标：上边 A-O，左边 1-15
        for (int i = 0; i < cols; i++)
            AddLabel(((char)('A' + i)).ToString(), PX(i), Pad - 18, dim);
        for (int i = 0; i < rows; i++)
            AddLabel((i + 1).ToString(), Pad - 18, PY(i), dim);

        var board = Game?.Board;
        var win = Game?.WinLine;
        if (board != null)
        {
            for (int y = 0; y < rows && y < board.Length; y++)
            {
                if (board[y] == null) continue;
                for (int x = 0; x < cols && x < board[y]!.Length; x++)
                {
                    var code = board[y][x];
                    if (string.IsNullOrEmpty(code)) continue;
                    bool inWin = win != null && win.Any(p => p.X == x && p.Y == y);
                    DrawStone(x, y, code[0] == 'b' || code[0] == 'B', inWin);
                }
            }
        }

        // 最后落子标记（红点）
        var last = Game?.LastMove;
        if (last != null)
        {
            var lx = last.To?.X ?? last.From?.X ?? 0;
            var ly = last.To?.Y ?? last.From?.Y ?? 0;
            var mark = new Rectangle
            {
                Width = 8, Height = 8,
                Fill = new SolidColorBrush(Color.FromRgb(0xE7, 0x4C, 0x3C)),
                IsHitTestVisible = false,
            };
            Canvas.SetLeft(mark, PX(lx) - 4);
            Canvas.SetTop(mark, PY(ly) - 4);
            _canvas.Children.Add(mark);
        }
    }

    private void DrawStar(int x, int y)
    {
        var d = new Ellipse
        {
            Width = 8, Height = 8,
            Fill = new SolidColorBrush(Color.FromRgb(0x3A, 0x22, 0x0A)),
            IsHitTestVisible = false,
        };
        Canvas.SetLeft(d, PX(x) - 4);
        Canvas.SetTop(d, PY(y) - 4);
        _canvas.Children.Add(d);
    }

    private void DrawStone(int x, int y, bool black, bool win)
    {
        var cx = PX(x);
        var cy = PY(y);
        var stone = new Ellipse
        {
            Width = StoneR * 2,
            Height = StoneR * 2,
            Fill = black
                ? new SolidColorBrush(Color.FromRgb(0x1A, 0x1A, 0x1A))
                : new SolidColorBrush(Color.FromRgb(0xF5, 0xF0, 0xE6)),
            Stroke = black
                ? new SolidColorBrush(Color.FromRgb(0x08, 0x08, 0x08))
                : new SolidColorBrush(Color.FromRgb(0x88, 0x88, 0x88)),
            StrokeThickness = 1.2,
            IsHitTestVisible = false,
        };
        Canvas.SetLeft(stone, cx - StoneR);
        Canvas.SetTop(stone, cy - StoneR);
        _canvas.Children.Add(stone);

        if (!black)
        {
            // 白子高光
            var hi = new Ellipse
            {
                Width = 8, Height = 6,
                Fill = new SolidColorBrush(Color.FromArgb(90, 255, 255, 255)),
                IsHitTestVisible = false,
            };
            Canvas.SetLeft(hi, cx - 6);
            Canvas.SetTop(hi, cy - 8);
            _canvas.Children.Add(hi);
        }

        if (win)
        {
            var ring = new Ellipse
            {
                Width = StoneR * 2 + 8,
                Height = StoneR * 2 + 8,
                Stroke = new SolidColorBrush(Color.FromRgb(0xF1, 0xC4, 0x0F)),
                StrokeThickness = 3,
                IsHitTestVisible = false,
            };
            Canvas.SetLeft(ring, cx - StoneR - 4);
            Canvas.SetTop(ring, cy - StoneR - 4);
            _canvas.Children.Add(ring);
        }
    }

    private void AddLabel(string text, double cx, double cy, Brush brush)
    {
        var tb = new TextBlock
        {
            Text = text,
            FontSize = 11,
            FontWeight = FontWeights.SemiBold,
            Foreground = brush,
            IsHitTestVisible = false,
        };
        tb.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        Canvas.SetLeft(tb, cx - tb.DesiredSize.Width / 2);
        Canvas.SetTop(tb, cy - tb.DesiredSize.Height / 2);
        _canvas.Children.Add(tb);
    }
}
