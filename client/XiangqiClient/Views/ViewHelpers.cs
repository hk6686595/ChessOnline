using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;

namespace XiangqiClient.Views;

/// <summary>关闭 ComboBox / Popup，避免窗口销毁时动画被取消后抛出 TaskCanceledException。</summary>
internal static class ViewHelpers
{
    public static void CloseComboDropDowns(DependencyObject root)
    {
        switch (root)
        {
            case ComboBox cb:
                cb.IsDropDownOpen = false;
                break;
            case Popup popup:
                popup.IsOpen = false;
                break;
        }

        // Popup 不在可视化树里，必须走逻辑树才能关到表情选择器等独立弹出层
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
            CloseComboDropDowns(child);
    }
}
