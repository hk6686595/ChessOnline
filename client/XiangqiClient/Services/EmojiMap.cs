using System.Collections.Generic;
using System.Linq;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace XiangqiClient.Services;

/// <summary>
/// 表情贴图映射：emoji 字符 ↔ 内置 PNG（tools/gen-emoji.ps1 生成的原创黄色笑脸）。
/// WPF 不支持彩色 emoji 字体，聊天中的表情统一用图片渲染。
/// </summary>
public static class EmojiMap
{
    public static readonly IReadOnlyList<string> All = new[]
    {
        "😀", "😁", "😂", "🤣", "😅", "😊", "😇", "🙂",
        "😉", "😍", "🤩", "😘", "😗", "😚", "😋", "😛",
        "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫", "🤔",
        "🤐", "😐", "😑", "😶", "😏", "😒", "🙄", "😬",
        "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕",
    };

    private static readonly Dictionary<string, ImageSource?> Cache = new();

    private static string Strip(string s) => s.Replace("\uFE0F", "");

    /// <summary>该文本元素是否为内置表情</summary>
    public static bool Contains(string textElement) => All.Contains(Strip(textElement));

    /// <summary>取表情贴图；非内置表情返回 null</summary>
    public static ImageSource? GetImage(string textElement)
    {
        var key = Strip(textElement);
        if (!All.Contains(key)) return null;
        if (Cache.TryGetValue(key, out var cached)) return cached;
        try
        {
            var code = char.ConvertToUtf32(key, 0);
            var src = BitmapFrame.Create(new Uri($"pack://application:,,,/assets/emoji/{code:x4}.png"));
            Cache[key] = src;
            return src;
        }
        catch
        {
            Cache[key] = null;
            return null;
        }
    }
}
