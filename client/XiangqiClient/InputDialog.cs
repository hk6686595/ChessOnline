using System.Windows;

namespace XiangqiClient;

/// <summary>简单的单行输入对话框（如房间密码）</summary>
public partial class InputDialog : Window
{
    public InputDialog(string title, string prompt)
    {
        Title = title;
        Width = 360;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var panel = new System.Windows.Controls.StackPanel { Margin = new Thickness(16) };
        panel.Children.Add(new System.Windows.Controls.TextBlock
        {
            Text = prompt,
            Margin = new Thickness(0, 0, 0, 8),
            TextWrapping = TextWrapping.Wrap,
        });
        ValueBox = new System.Windows.Controls.PasswordBox { Margin = new Thickness(0, 0, 0, 12) };
        panel.Children.Add(ValueBox);
        var btns = new System.Windows.Controls.StackPanel
        {
            Orientation = System.Windows.Controls.Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
        };
        var ok = new System.Windows.Controls.Button { Content = "确定", Width = 80, Margin = new Thickness(0, 0, 8, 0) };
        var cancel = new System.Windows.Controls.Button { Content = "取消", Width = 80 };
        // 使用应用级深色主题按钮样式（App.xaml 资源），避免默认浅色样式突兀
        if (Application.Current?.Resources != null)
        {
            if (Application.Current.Resources.Contains("PrimaryBtn")) ok.Style = (System.Windows.Style)Application.Current.Resources["PrimaryBtn"];
            if (Application.Current.Resources.Contains("Btn")) cancel.Style = (System.Windows.Style)Application.Current.Resources["Btn"];
        }
        ok.Click += (_, _) => { DialogResult = true; };
        cancel.Click += (_, _) => { DialogResult = false; };
        btns.Children.Add(ok);
        btns.Children.Add(cancel);
        panel.Children.Add(btns);
        Content = panel;
        Loaded += (_, _) => ValueBox.Focus();
    }

    public System.Windows.Controls.PasswordBox ValueBox { get; }
    public string Value => ValueBox.Password;
}
