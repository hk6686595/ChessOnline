using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using XiangqiClient.Models;
using XiangqiClient.ViewModels;

namespace XiangqiClient.Views;

public partial class LobbyView : UserControl
{
    public LobbyView()
    {
        InitializeComponent();
        // 私聊消息最新置顶，新消息到达时滚动到顶部
        PrivateChatList.ItemContainerGenerator.ItemsChanged += (_, _) =>
        {
            if (PrivateChatList.Items.Count > 0)
                PrivateChatList.ScrollIntoView(PrivateChatList.Items[0]);
        };
    }

    private MainViewModel? Vm => DataContext as MainViewModel;

    /// <summary>表情选择器：把选中的表情追加到大厅聊天输入框</summary>
    private void LobbyEmoji_Picked(string emoji)
    {
        if (Vm != null) Vm.LobbyChatInput += emoji;
    }

    /// <summary>表情选择器：把选中的表情追加到私聊输入框</summary>
    private void PrivateEmoji_Picked(string emoji)
    {
        if (Vm != null) Vm.PrivateInput += emoji;
    }

    private void Logout_Click(object sender, RoutedEventArgs e) => Vm?.LogoutAsync();

    private void Avatar_Click(object sender, RoutedEventArgs e)
    {
        if (Vm != null) Vm.AvatarPanelOpen = true;
    }

    private void CloseAvatar_Click(object sender, RoutedEventArgs e)
    {
        if (Vm != null) Vm.AvatarPanelOpen = false;
    }

    /// <summary>点击遮罩层关闭头像面板</summary>
    private void AvatarOverlay_MouseDown(object sender, MouseButtonEventArgs e)
    {
        if (Vm != null) Vm.AvatarPanelOpen = false;
    }

    /// <summary>阻止点击面板内部时关闭</summary>
    private void AvatarPanel_MouseDown(object sender, MouseButtonEventArgs e)
    {
        e.Handled = true;
    }

    /// <summary>好友右键菜单：私聊</summary>
    private void FriendMenu_PrivateChat(object sender, RoutedEventArgs e)
    {
        if (sender is MenuItem mi && mi.DataContext is FriendInfo friend && Vm != null)
        {
            Vm.OpenPrivateChatCmd.Execute(friend);
        }
    }

    /// <summary>好友右键菜单：删除</summary>
    private void FriendMenu_Remove(object sender, RoutedEventArgs e)
    {
        if (sender is MenuItem mi && mi.DataContext is FriendInfo friend && Vm != null)
        {
            Vm.RemoveFriendCmd.Execute(friend);
        }
    }

    /// <summary>双击好友项打开私聊</summary>
    private void FriendItem_DoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (sender is ListViewItem item && item.DataContext is FriendInfo friend && Vm != null)
        {
            Vm.OpenPrivateChatCmd.Execute(friend);
        }
    }

    private void RoomList_DoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (RoomListView.SelectedItem is RoomListItem item)
        {
            Vm?.JoinRoom(item.Id, item.HasPassword);
        }
    }

    private void LobbyChat_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Vm != null && Vm.SendLobbyChatCmd.CanExecute(null))
        {
            Vm.SendLobbyChatCmd.Execute(null);
        }
    }

    private void PrivateChat_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Vm != null && Vm.SendPrivateChatCmd.CanExecute(null))
        {
            Vm.SendPrivateChatCmd.Execute(null);
        }
    }
}
