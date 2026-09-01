using System.Windows;
using System.Windows.Controls;
using XiangqiClient.Services;

namespace XiangqiClient.Controls;

/// <summary>
/// 聊天表情选择器：点击 😊 弹出表情面板（内置彩色贴图），
/// 选中后触发 EmojiPicked 事件（参数为 emoji 字符，由调用方追加到输入框）。
/// 大厅聊天与房间聊天共用。
/// </summary>
public partial class EmojiPicker : UserControl
{
    /// <summary>选中某个表情</summary>
    public event Action<string>? EmojiPicked;

    public EmojiPicker()
    {
        InitializeComponent();
        foreach (var emoji in EmojiMap.All)
        {
            var btn = new Button { Style = (Style)Resources["EmojiBtn"], ToolTip = emoji };
            btn.Content = new Image
            {
                Source = EmojiMap.GetImage(emoji),
                Width = 26,
                Height = 26,
            };
            btn.Click += (_, _) =>
            {
                EmojiPicked?.Invoke(emoji);
                Popup.IsOpen = false;
            };
            Panel.Children.Add(btn);
        }
    }

    private void OpenBtn_Click(object sender, RoutedEventArgs e)
    {
        Popup.PlacementTarget = OpenBtn;
        Popup.IsOpen = true;
    }
}
