using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using XiangqiClient.Services;

namespace XiangqiClient.Controls;

/// <summary>
/// 支持内嵌表情贴图的文本控件：把消息文本中的内置 emoji 替换为彩色 PNG，
/// 其余文字正常显示。用于聊天气泡（WPF 字体渲染 emoji 为单色，故用图片方案）。
/// </summary>
public class EmojiTextBlock : ContentControl
{
    public static readonly DependencyProperty TextProperty = DependencyProperty.Register(
        nameof(Text), typeof(string), typeof(EmojiTextBlock),
        new PropertyMetadata("", (d, _) => ((EmojiTextBlock)d).Rebuild()));

    /// <summary>消息文本（可含 emoji）</summary>
    public string Text
    {
        get => (string)GetValue(TextProperty);
        set => SetValue(TextProperty, value);
    }

    /// <summary>表情图片边长（与正文字号匹配）</summary>
    public double EmojiSize { get; set; } = 17;

    public EmojiTextBlock()
    {
        Rebuild();
    }

    private void Rebuild()
    {
        var tb = new TextBlock { TextWrapping = TextWrapping.Wrap };
        var text = Text ?? "";
        var it = StringInfo.GetTextElementEnumerator(text);
        while (it.MoveNext())
        {
            var el = (string)it.Current!;
            var img = EmojiMap.GetImage(el);
            if (img != null)
            {
                tb.Inlines.Add(new InlineUIContainer(new Image
                {
                    Source = img,
                    Width = EmojiSize,
                    Height = EmojiSize,
                    Margin = new Thickness(0.5, 0, 0.5, -2),
                })
                { BaselineAlignment = BaselineAlignment.Bottom });
            }
            else
            {
                tb.Inlines.Add(new Run(el));
            }
        }
        Content = tb;
    }
}
