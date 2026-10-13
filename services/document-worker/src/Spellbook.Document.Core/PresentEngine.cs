using System.Diagnostics;

namespace Spellbook.Document.Core;

/// <summary>
/// One of the document engine's command-line programs (engine/ and formats/ in this repository):
/// present-pptx for PowerPoint decks, present-idml for InDesign documents. Each call is one
/// process; previews are drawn with the fallback fonts the browser document view uses
/// (SPELLBOOK_ENGINE_FONTS, default /app/fonts), so a preview looks like the view.
/// </summary>
public sealed class EngineProgram(string path, string formatId)
{
    static readonly TimeSpan Timeout = TimeSpan.FromMinutes(5);

    public string Path => path;

    /// <summary>The program named by <paramref name="variable"/> or found at its default path, or null.</summary>
    public static string? Configured(string variable, string defaultPath) =>
        Environment.GetEnvironmentVariable(variable) is { Length: > 0 } configured
            ? (File.Exists(configured) ? configured : null)
            : (File.Exists(defaultPath) ? defaultPath : null);

    public static string? FontsDirectory =>
        Environment.GetEnvironmentVariable("SPELLBOOK_ENGINE_FONTS") is { Length: > 0 } configured
            ? configured
            : Directory.Exists("/app/fonts") ? "/app/fonts" : null;

    /// <summary>What the engine reports for each build of these programs.</summary>
    public static string Version =>
        Environment.GetEnvironmentVariable("SPELLBOOK_ENGINE_VERSION") is { Length: > 0 } version ? version : "unversioned";

    /// <summary>Previews (slide-N.png or page-N.png) 1280 px wide, in document order.</summary>
    public IReadOnlyList<string> RenderAll(string file, string directory) =>
        Run(WithFonts("render-all", file, directory, "1280"))
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    /// <summary>The engine's font report for a deck (present-pptx fonts).</summary>
    public string Fonts(string file) => Run(WithFonts("fonts", file));

    public string Run(params string[] arguments)
    {
        var start = new ProcessStartInfo(path)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException($"{formatId}_engine_unavailable");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(Timeout))
        {
            process.Kill(entireProcessTree: true);
            throw new RenderTimeoutException(Timeout);
        }
        if (process.ExitCode != 0)
        {
            // The engine names the problem on its first line; document contents never reach the log.
            var reason = stderr.Result.Split('\n', 2)[0].Trim();
            throw new InvalidDataException($"{formatId}_{arguments[0]}_failed: {reason[..Math.Min(reason.Length, 300)]}");
        }
        return stdout.Result;
    }

    static string[] WithFonts(params string[] arguments) =>
        FontsDirectory is { } fonts ? [.. arguments, "--fonts", fonts] : arguments;
}
