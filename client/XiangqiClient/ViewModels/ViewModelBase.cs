using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Input;

namespace XiangqiClient.ViewModels;

/// <summary>MVVM 基类：属性变更通知</summary>
public abstract class ViewModelBase : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    protected void OnPropertyChanged([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    protected bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        OnPropertyChanged(name);
        // 状态变化后刷新所有命令的 CanExecute（如对局开始后"认输"立即可用、
        // 双方就绪后"开始对局"立即可用），否则依赖输入事件触发的 RequerySuggested 可能滞后
        CommandManager.InvalidateRequerySuggested();
        return true;
    }
}
