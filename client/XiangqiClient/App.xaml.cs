using System.Windows;

namespace XiangqiClient;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        // 退出时取消进行中的异步操作（WebSocket / Popup 淡出动画）会抛出
        // TaskCanceledException，这不是用户需要看到的错误。
        DispatcherUnhandledException += (_, args) =>
        {
            if (IsCancellation(args.Exception) || Dispatcher.HasShutdownStarted)
            {
                args.Handled = true;
                return;
            }
            var msg = args.Exception.Message;
            for (var inner = args.Exception.InnerException; inner != null; inner = inner.InnerException)
                msg += "\n" + inner.Message;
            MessageBox.Show(
                "程序遇到未处理的错误：\n" + msg,
                "对战平台",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
            args.Handled = true;
        };
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            if (args.Exception.Flatten().InnerExceptions.All(IsCancellation))
                args.SetObserved();
        };
        base.OnStartup(e);
    }

    private static bool IsCancellation(Exception ex)
        => ex is OperationCanceledException or TaskCanceledException;
}
