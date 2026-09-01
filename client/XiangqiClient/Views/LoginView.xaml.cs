using System.Windows;
using System.Windows.Controls;
using XiangqiClient.ViewModels;

namespace XiangqiClient.Views;

public partial class LoginView : UserControl
{
    public LoginView()
    {
        InitializeComponent();
        // 登录页每次可见时清理注册表单；密码框按"记住账号"策略处理
        IsVisibleChanged += (_, _) =>
        {
            if (!IsVisible) return;
            RegPassBox.Clear();
            RegConfirmBox.Clear();
            if (Vm != null)
            {
                Vm.RegisterPassword = "";
                Vm.RegisterConfirm = "";
                Vm.FormError = "";
                // 记住账号：自动填充登录密码框；否则清空避免残留
                if (Vm.RememberAccount && !string.IsNullOrEmpty(Vm.SavedPassword))
                {
                    PassBox.Password = Vm.SavedPassword;
                    Vm.LoginPassword = Vm.SavedPassword;
                }
                else
                {
                    PassBox.Clear();
                    Vm.LoginPassword = "";
                }
            }
        };
    }

    private MainViewModel? Vm => DataContext as MainViewModel;

    /// <summary>从历史账号下拉选择后：若勾选了记住账号且该账号匹配已保存项，则自动填充密码；否则清空密码框</summary>
    private void NameBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (Vm == null) return;
        if (NameBox.SelectedItem is string sel)
        {
            if (Vm.RememberAccount && sel == Vm.SavedName && !string.IsNullOrEmpty(Vm.SavedPassword))
            {
                PassBox.Password = Vm.SavedPassword;
                Vm.LoginPassword = Vm.SavedPassword;
            }
            else
            {
                PassBox.Clear();
                Vm.LoginPassword = "";
            }
        }
    }

    /// <summary>用记住的账号填充登录表单（窗口启动时调用）</summary>
    public void RestoreSavedAccount()
    {
        if (Vm == null) return;
        if (Vm.RememberAccount && !string.IsNullOrEmpty(Vm.SavedPassword))
        {
            PassBox.Password = Vm.SavedPassword;
            Vm.LoginPassword = Vm.SavedPassword;
        }
    }

    private void PassBox_PasswordChanged(object sender, RoutedEventArgs e)
    {
        if (Vm != null) Vm.LoginPassword = PassBox.Password;
    }

    private void RegPassBox_PasswordChanged(object sender, RoutedEventArgs e)
    {
        if (Vm != null) Vm.RegisterPassword = RegPassBox.Password;
    }

    private void RegConfirmBox_PasswordChanged(object sender, RoutedEventArgs e)
    {
        if (Vm != null) Vm.RegisterConfirm = RegConfirmBox.Password;
    }

    private void TabLogin_Click(object sender, RoutedEventArgs e) => Vm?.SwitchMode(false);
    private void TabRegister_Click(object sender, RoutedEventArgs e) => Vm?.SwitchMode(true);
    private void Login_Click(object sender, RoutedEventArgs e) => Vm?.LoginAsync();
    private void Register_Click(object sender, RoutedEventArgs e) => Vm?.RegisterAsync();
    private void Guest_Click(object sender, RoutedEventArgs e) => Vm?.GuestAsync();

    /// <summary>填充测试账号（DEBUG 专用）：设置 VM 属性并同步密码框</summary>
    private void TestFill_Click(object sender, RoutedEventArgs e)
    {
        if (Vm == null) return;
        Vm.FillTestRegister();
        RegNameBox.Text = Vm.RegisterName;
        RegPassBox.Password = Vm.RegisterPassword;
        RegConfirmBox.Password = Vm.RegisterConfirm;
    }
}
