using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using XiangqiClient.Models;
using XiangqiClient.ViewModels;

namespace XiangqiClient.Views;

public partial class RoomView : UserControl
{
    public RoomView()
    {
        InitializeComponent();
    }

    private MainViewModel? Vm => DataContext as MainViewModel;

    /// <summary>表情选择器：把选中的表情追加到房间聊天输入框</summary>
    private void RoomEmoji_Picked(string emoji)
    {
        if (Vm != null) Vm.RoomChatInput += emoji;
    }

    private void Board_CellClicked(Point2 cell)
    {
        if (Vm != null && Vm.CellClickCmd.CanExecute(cell))
        {
            Vm.CellClickCmd.Execute(cell);
        }
    }

    private void RoomChat_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Vm != null && Vm.SendRoomChatCmd.CanExecute(null))
        {
            Vm.SendRoomChatCmd.Execute(null);
        }
    }
}
