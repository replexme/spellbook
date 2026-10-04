namespace Spellbook.Document.Core;

/// <summary>
/// A render exceeded the renderer's own deadline. Every subprocess started by
/// that render has been stopped before this is thrown, so the job can fail
/// terminally instead of running until the host kills the request.
/// </summary>
public sealed class RenderTimeoutException(TimeSpan timeout)
    : TimeoutException($"Rendering exceeded the {timeout.TotalSeconds:0} second limit.")
{
    public TimeSpan Timeout { get; } = timeout;
}
