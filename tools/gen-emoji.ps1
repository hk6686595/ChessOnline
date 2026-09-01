# gen-emoji.ps1 - Generate ORIGINAL yellow smiley PNG stickers for the client chat.
#   Outputs (into client\XiangqiClient\Assets\Emoji): <codepoint>.png (72x72, RGBA)
#   The emoji set is hand-drawn here (no third-party assets), filenames follow
#   the matching Unicode codepoints so the runtime can map text -> image.
# IMPORTANT: keep this file ASCII-only so it parses correctly on any PowerShell.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$cs = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;

public static class EmojiGen
{
    // codepoint -> [eyes, mouth, extra]
    private static readonly Dictionary<string, string[]> Set = new Dictionary<string, string[]>
    {
        {"1f600", new[]{"dot","grin",""}},        {"1f601", new[]{"arcup","grin","teeth"}},
        {"1f602", new[]{"arcup","laugh","tears"}}, {"1f923", new[]{"arcup","laugh","rofl"}},
        {"1f605", new[]{"dot","smile","sweat"}},   {"1f60a", new[]{"arcup","smile","blush"}},
        {"1f607", new[]{"dot","smile","halo"}},    {"1f642", new[]{"dot","smile",""}},
        {"1f609", new[]{"wink","smile",""}},       {"1f60d", new[]{"heart","laugh",""}},
        {"1f929", new[]{"star","grin","blush"}},   {"1f618", new[]{"wink","kiss","heart1"}},
        {"1f617", new[]{"line","kiss",""}},        {"1f61a", new[]{"arcdown","kiss",""}},
        {"1f60b", new[]{"dot","tongue",""}},       {"1f61b", new[]{"dot","tongue",""}},
        {"1f61c", new[]{"wink","tongue",""}},      {"1f92a", new[]{"zany","zany",""}},
        {"1f61d", new[]{"arcdown","tongue",""}},   {"1f911", new[]{"money","smile",""}},
        {"1f917", new[]{"arcup","open",""}},       {"1f92d", new[]{"arcup","smile","giggle"}},
        {"1f92b", new[]{"line","smallO","finger"}},{"1f914", new[]{"think","flat","brow"}},
        {"1f910", new[]{"line","zipper",""}},      {"1f610", new[]{"dot","flat",""}},
        {"1f611", new[]{"line","flat",""}},        {"1f636", new[]{"dot","none",""}},
        {"1f60f", new[]{"dot","smirk",""}},        {"1f612", new[]{"half","sad",""}},
        {"1f644", new[]{"roll","flat",""}},        {"1f62c", new[]{"dot","grimace",""}},
        {"1f60c", new[]{"arcdown","smile","blush"}},{"1f614", new[]{"half","sad",""}},
        {"1f62a", new[]{"droopy","smallO",""}},    {"1f924", new[]{"dot","smile","drool"}},
        {"1f634", new[]{"arcdown","none","zzz"}},  {"1f637", new[]{"dot","mask",""}},
        {"1f912", new[]{"dot","sad","thermo"}},    {"1f915", new[]{"dot","sad","bandage"}},
    };

    public static void GenerateAll(string dir)
    {
        Directory.CreateDirectory(dir);
        foreach (var kv in Set)
            Generate(Path.Combine(dir, kv.Key + ".png"), kv.Value[0], kv.Value[1], kv.Value[2]);
    }

    private static readonly Color FaceLight = Color.FromArgb(255, 255, 224, 100);
    private static readonly Color FaceDark = Color.FromArgb(255, 255, 192, 46);
    private static readonly Color Rim = Color.FromArgb(210, 214, 148, 20);
    private static readonly Color Ink = Color.FromArgb(235, 122, 78, 18);

    private static void Generate(string path, string eyes, string mouth, string extra)
    {
        using (var bmp = new Bitmap(72, 72))
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var grad = new LinearGradientBrush(new Rectangle(4, 4, 64, 64), FaceLight, FaceDark, 55f))
            {
                g.FillEllipse(grad, 5, 5, 62, 62);
            }
            using (var pen = new Pen(Rim, 2.4f))
                g.DrawEllipse(pen, 6.2f, 6.2f, 59.6f, 59.6f);

            DrawEyes(g, eyes);
            if (mouth != "mask") DrawMouth(g, mouth);
            DrawExtra(g, extra, mouth);

            bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
    }

    private static Pen InkPen(float w) { return new Pen(Ink, w) { StartCap = LineCap.Round, EndCap = LineCap.Round }; }

    private static void DrawEyes(Graphics g, string kind)
    {
        int ly = 30, lx = 24, rx = 48;
        switch (kind)
        {
            case "dot":
                FillCircle(g, lx, ly, 3.6f, Ink); FillCircle(g, rx, ly, 3.6f, Ink);
                break;
            case "line":
                using (var p = InkPen(3.4f))
                {
                    g.DrawLine(p, lx - 5, ly, lx + 5, ly);
                    g.DrawLine(p, rx - 5, ly, rx + 5, ly);
                }
                break;
            case "arcup": // happy ^ ^
                using (var p = InkPen(3.4f))
                {
                    g.DrawArc(p, lx - 6, ly - 3, 12, 11, 190, 160);
                    g.DrawArc(p, rx - 6, ly - 3, 12, 11, 190, 160);
                }
                break;
            case "arcdown": // relieved u u
                using (var p = InkPen(3.4f))
                {
                    g.DrawArc(p, lx - 6, ly - 4, 12, 11, 15, 150);
                    g.DrawArc(p, rx - 6, ly - 4, 12, 11, 15, 150);
                }
                break;
            case "wink":
                FillCircle(g, lx, ly, 3.6f, Ink);
                using (var p = InkPen(3.4f)) g.DrawLine(p, rx - 5, ly, rx + 5, ly);
                break;
            case "half":
                using (var p = InkPen(3.0f))
                {
                    g.DrawLine(p, lx - 5, ly - 2, lx + 5, ly - 2);
                    g.DrawLine(p, rx - 5, ly - 2, rx + 5, ly - 2);
                }
                FillCircle(g, lx, ly + 3, 2.6f, Ink); FillCircle(g, rx, ly + 3, 2.6f, Ink);
                break;
            case "roll":
                foreach (int x in new[] { lx, rx })
                {
                    using (var w = new SolidBrush(Color.White)) g.FillEllipse(w, x - 6, ly - 7, 12, 13);
                    using (var p = new Pen(Ink, 1.8f)) g.DrawEllipse(p, x - 6, ly - 7, 12, 13);
                    FillCircle(g, x, ly - 3, 2.8f, Ink);
                }
                break;
            case "heart":
                DrawHeart(g, lx, ly, 9, Color.FromArgb(235, 232, 51, 71));
                DrawHeart(g, rx, ly, 9, Color.FromArgb(235, 232, 51, 71));
                break;
            case "star":
                DrawStar(g, lx, ly, 8, Color.FromArgb(240, 255, 157, 0));
                DrawStar(g, rx, ly, 8, Color.FromArgb(240, 255, 157, 0));
                break;
            case "money":
                foreach (int x in new[] { lx, rx })
                {
                    using (var gr = new SolidBrush(Color.FromArgb(235, 102, 187, 106))) g.FillEllipse(gr, x - 6, ly - 6, 12, 12);
                    var f = new Font("Arial", 9f, FontStyle.Bold);
                    var sz = g.MeasureString("$", f);
                    using (var t = new SolidBrush(Color.White)) g.DrawString("$", f, t, x - sz.Width / 2f, ly - sz.Height / 2f + 1);
                    f.Dispose();
                }
                break;
            case "zany":
                using (var w = new SolidBrush(Color.White)) g.FillEllipse(w, lx - 7, ly - 7, 14, 15);
                using (var p = new Pen(Ink, 1.8f)) g.DrawEllipse(p, lx - 7, ly - 7, 14, 15);
                FillCircle(g, lx + 2, ly - 1, 3.2f, Ink);
                using (var p2 = InkPen(3.4f)) g.DrawLine(p2, rx - 5, ly, rx + 5, ly);
                break;
            case "droopy":
                using (var p = InkPen(3.4f))
                {
                    g.DrawArc(p, lx - 6, ly - 5, 12, 12, 30, 130);
                    g.DrawArc(p, rx - 6, ly - 5, 12, 12, 30, 130);
                }
                break;
            case "think":
                FillCircle(g, lx, ly + 1, 3.4f, Ink); FillCircle(g, rx, ly - 1, 3.4f, Ink);
                break;
        }
    }

    private static void DrawMouth(Graphics g, string kind)
    {
        int my = 47;
        switch (kind)
        {
            case "grin": // wide filled smile with tongue
                using (var path = new GraphicsPath())
                {
                    path.AddArc(19, my - 8, 34, 24, 15, 150);
                    path.CloseFigure();
                    using (var b = new SolidBrush(Ink)) g.FillPath(b, path);
                    using (var t = new SolidBrush(Color.FromArgb(230, 240, 110, 120)))
                        g.FillPie(t, 28, my + 4, 16, 10, 10, 160);
                }
                break;
            case "laugh":
                using (var path = new GraphicsPath())
                {
                    path.AddArc(21, my - 9, 30, 26, 12, 156);
                    path.CloseFigure();
                    using (var b = new SolidBrush(Ink)) g.FillPath(b, path);
                }
                break;
            case "open":
                using (var path = new GraphicsPath())
                {
                    path.AddArc(24, my - 6, 24, 20, 15, 150);
                    path.CloseFigure();
                    using (var b = new SolidBrush(Ink)) g.FillPath(b, path);
                }
                break;
            case "smile":
                using (var p = InkPen(3.4f)) g.DrawArc(p, 25, my - 8, 22, 16, 25, 130);
                break;
            case "sad":
                using (var p = InkPen(3.4f)) g.DrawArc(p, 25, my + 2, 22, 14, 205, 130);
                break;
            case "flat":
                using (var p = InkPen(3.4f)) g.DrawLine(p, 26, my + 2, 46, my + 2);
                break;
            case "smirk":
                using (var p = InkPen(3.4f)) g.DrawArc(p, 30, my - 2, 16, 12, 40, 100);
                break;
            case "smallO":
                FillCircle(g, 36, my + 2, 3.4f, Ink);
                break;
            case "kiss":
                FillCircle(g, 36, my + 2, 4.2f, Ink);
                break;
            case "tongue":
                using (var p = InkPen(3.4f)) g.DrawArc(p, 25, my - 8, 22, 16, 25, 130);
                using (var t = new SolidBrush(Color.FromArgb(235, 240, 110, 120)))
                    g.FillRectangle(t, 32, my + 3, 9, 10);
                break;
            case "zany":
                using (var path = new GraphicsPath())
                {
                    path.AddArc(22, my - 6, 14, 14, 90, 180);
                    path.AddArc(36, my - 2, 14, 14, 270, 180);
                    path.CloseFigure();
                    using (var b = new SolidBrush(Ink)) g.FillPath(b, path);
                }
                break;
            case "zipper":
                using (var p = InkPen(3.2f))
                {
                    g.DrawLine(p, 25, my + 2, 47, my + 2);
                    for (int x = 29; x <= 43; x += 7) g.DrawLine(p, x, my - 2, x, my + 6);
                }
                break;
            case "grimace":
                var r = new Rectangle(21, my - 4, 30, 13);
                using (var w = new SolidBrush(Color.White)) { g.FillRectangle(w, r); g.DrawRectangle(new Pen(Ink, 1.6f), r); }
                using (var p = new Pen(Ink, 1.4f))
                {
                    for (int i = 1; i < 4; i++) { float x = r.X + i * 7.5f; g.DrawLine(p, x, r.Y, x, r.Bottom); }
                    g.DrawLine(p, r.X, r.Y + 6.5f, r.Right, r.Y + 6.5f);
                }
                break;
            case "mask":
                var mr = new Rectangle(14, 42, 44, 20);
                using (var m = new SolidBrush(Color.FromArgb(245, 228, 242, 236))) FillRound(g, mr, 7, m);
                using (var p = new Pen(Color.FromArgb(160, 170, 185, 178), 1.6f)) DrawRound(g, mr, 7, p);
                using (var sp = new Pen(Color.FromArgb(150, 150, 165, 158), 2f))
                {
                    g.DrawLine(sp, 14, 48, 6, 45);
                    g.DrawLine(sp, 58, 48, 66, 45);
                    g.DrawLine(sp, 14, 56, 7, 58);
                    g.DrawLine(sp, 58, 56, 65, 58);
                }
                using (var lp = new Pen(Color.FromArgb(70, 122, 78, 18), 1.4f))
                {
                    g.DrawLine(lp, 24, 48, 48, 48);
                    g.DrawLine(lp, 24, 54, 48, 54);
                }
                break;
        }
    }

    private static void DrawExtra(Graphics g, string kind, string mouth)
    {
        switch (kind)
        {
            case "tears":
                DrawTear(g, 13, 38, 7, 12);
                DrawTear(g, 59, 38, 7, 12, true);
                break;
            case "rofl":
                DrawTear(g, 11, 34, 6, 11);
                DrawTear(g, 61, 34, 6, 11, true);
                break;
            case "sweat":
                DrawTear(g, 57, 18, 6, 10);
                break;
            case "blush":
                using (var b = new SolidBrush(Color.FromArgb(90, 255, 130, 120)))
                {
                    g.FillEllipse(b, 13, 40, 11, 6);
                    g.FillEllipse(b, 48, 40, 11, 6);
                }
                break;
            case "halo":
                using (var p = new Pen(Color.FromArgb(235, 255, 213, 79), 4f))
                    g.DrawEllipse(p, 20, 1, 32, 9);
                break;
            case "heart1":
                DrawHeart(g, 56, 16, 9, Color.FromArgb(235, 232, 51, 71));
                break;
            case "giggle":
                using (var b = new SolidBrush(Color.FromArgb(235, 255, 224, 130)))
                    FillRound(g, new Rectangle(30, 50, 14, 12), 5, b);
                break;
            case "finger":
                using (var b = new SolidBrush(Color.FromArgb(235, 255, 213, 140)))
                    FillRound(g, new Rectangle(33, 44, 6, 20), 3, b);
                break;
            case "brow":
                using (var p = InkPen(3f))
                {
                    g.DrawLine(p, 18, 20, 29, 23);
                    g.DrawLine(p, 43, 23, 54, 20);
                }
                break;
            case "drool":
                DrawTear(g, 44, 55, 5, 9);
                break;
            case "zzz":
                var f = new Font("Arial", 11f, FontStyle.Bold);
                using (var t = new SolidBrush(Color.FromArgb(220, 96, 165, 250)))
                {
                    g.DrawString("z", f, t, 52, 8);
                    g.DrawString("z", f, t, 60, 18);
                }
                f.Dispose();
                break;
            case "thermo":
                using (var b = new SolidBrush(Color.White)) FillRound(g, new Rectangle(30, 46, 12, 16), 4, b);
                using (var r = new SolidBrush(Color.FromArgb(230, 235, 77, 75))) g.FillRectangle(r, 34, 54, 4, 8);
                break;
            case "bandage":
                var state = g.Save();
                g.ResetTransform();
                using (var b = new SolidBrush(Color.FromArgb(235, 245, 218, 170)))
                {
                    var old = g.Transform;
                    var mx = new Matrix();
                    mx.RotateAt(-18f, new PointF(36, 16));
                    g.Transform = mx;
                    FillRound(g, new Rectangle(18, 12, 36, 9), 4, b);
                    g.Transform = old;
                }
                g.Restore(state);
                break;
        }
    }

    private static void FillCircle(Graphics g, float cx, float cy, float r, Color c)
    {
        using (var b = new SolidBrush(c)) g.FillEllipse(b, cx - r, cy - r, r * 2, r * 2);
    }

    private static void FillRound(Graphics g, Rectangle r, int rad, Brush b)
    {
        using (var path = RoundPath(r, rad)) g.FillPath(b, path);
    }

    private static void DrawRound(Graphics g, Rectangle r, int rad, Pen p)
    {
        using (var path = RoundPath(r, rad)) g.DrawPath(p, path);
    }

    private static GraphicsPath RoundPath(Rectangle r, int rad)
    {
        var path = new GraphicsPath();
        int d = rad * 2;
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static void DrawTear(Graphics g, float cx, float cy, float w, float h, bool flip = false)
    {
        using (var b = new SolidBrush(Color.FromArgb(225, 89, 194, 240)))
        using (var path = new GraphicsPath())
        {
            path.AddBezier(cx, cy - h / 2f, cx + w, cy, cx + w * 0.6f, cy + h * 0.55f, cx, cy + h / 2f);
            path.StartFigure();
            path.AddBezier(cx, cy - h / 2f, cx - w, cy, cx - w * 0.6f, cy + h * 0.55f, cx, cy + h / 2f);
            if (flip) { var m = new Matrix(); m.Translate(cx * 2f, 0); m.Scale(-1, 1); path.Transform(m); }
            g.FillPath(b, path);
        }
    }

    private static void DrawHeart(Graphics g, float cx, float cy, float size, Color c)
    {
        using (var b = new SolidBrush(c))
        using (var path = new GraphicsPath())
        {
            float s = size / 2f;
            path.AddBezier(cx, cy + s, cx - size, cy - s * 0.4f, cx - s * 0.9f, cy - size, cx, cy - s * 0.35f);
            path.StartFigure();
            path.AddBezier(cx, cy + s, cx + size, cy - s * 0.4f, cx + s * 0.9f, cy - size, cx, cy - s * 0.35f);
            g.FillPath(b, path);
        }
    }

    private static void DrawStar(Graphics g, float cx, float cy, float r, Color c)
    {
        var pts = new PointF[10];
        for (int i = 0; i < 10; i++)
        {
            double ang = -Math.PI / 2 + i * Math.PI / 5;
            float rr = i % 2 == 0 ? r : r * 0.45f;
            pts[i] = new PointF(cx + (float)(rr * Math.Cos(ang)), cy + (float)(rr * Math.Sin(ang)));
        }
        using (var b = new SolidBrush(c)) g.FillPolygon(b, pts);
    }
}
'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Drawing

$outDir = (Resolve-Path (Join-Path $PSScriptRoot '..\client\XiangqiClient\Assets\Emoji')).Path
[EmojiGen]::GenerateAll($outDir)
Write-Host "Emoji stickers generated in $outDir"
