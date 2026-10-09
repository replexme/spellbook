using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

namespace Spellbook.Document.Core;

/// <summary>Uses the same pinned browser SDK and native slide drawing as the editor.</summary>
public sealed class OnlyOfficeRenderer : IPresentationRenderer, IOwnedPresentationResources
{
    private readonly string script;
    private readonly PptxImagePixelBudget pixelBudget = PptxImagePixelBudget.FromEnvironment();
    private readonly TimeSpan timeout;

    public OnlyOfficeRenderer() : this(Environment.GetEnvironmentVariable("SPELLBOOK_ONLYOFFICE_RENDER_SCRIPT")
        ?? Path.Combine(Directory.GetCurrentDirectory(), "services/browser-office/onlyoffice/headless-renderer.mjs")) { }

    public OnlyOfficeRenderer(string script, TimeSpan? timeout = null)
    {
        this.timeout = timeout ?? TimeSpan.FromSeconds(300);
        if (this.timeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(timeout));
        this.script = Path.GetFullPath(script);
        var directory = Path.GetDirectoryName(this.script)!;
        // Preview reuse requires the drawing code and fixed vendor distribution
        // to agree, not just a marketing version such as '9.3'.
        using var identity = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var file in new[] { this.script, Path.Combine(directory, "slide-capture.mjs"),
            Path.Combine(directory, "distribution/distribution-manifest.json"),
            Path.Combine(directory, "workspace-dist/sdk.bundle.js"),
            Path.Combine(directory, "workspace-dist/workspace-source-receipt.json") })
            identity.AppendData(File.ReadAllBytes(file));
        Version = Convert.ToHexStringLower(identity.GetHashAndReset());
    }

    public string Name => "ONLYOFFICE";
    public string Version { get; }

    public async Task PrepareOwnedResourcesAsync(string inputPath, string inputObject,
        string? baselinePath, CancellationToken cancellationToken)
    {
        string? parentSha256 = null;
        if (baselinePath is not null)
        {
            await using var baseline = File.OpenRead(baselinePath);
            parentSha256 = Convert.ToHexStringLower(await SHA256.HashDataAsync(baseline, cancellationToken));
        }
        var preparation = Environment.GetEnvironmentVariable("SPELLBOOK_ONLYOFFICE_RESOURCE_SCRIPT")
            ?? Path.GetFullPath(Path.Combine(Path.GetDirectoryName(script)!,
                "../../document-resources/prepare-owned-pptx.mjs"));
        var arguments = new List<string> { Path.GetFullPath(inputPath), inputObject };
        if (parentSha256 is not null) arguments.Add(parentSha256);
        await RunNodeAsync(preparation, arguments, cancellationToken);
    }

    public async Task<IReadOnlyList<string>> RenderAsync(string pptxPath, string outputDirectory,
        CancellationToken cancellationToken, IReadOnlyList<int>? slideIndexes = null)
    {
        if (slideIndexes is not null && (slideIndexes.Any(index => index < 0) ||
            slideIndexes.Distinct().Count() != slideIndexes.Count))
            throw new ArgumentException("Selected slide indexes must be distinct and non-negative.", nameof(slideIndexes));
        if (slideIndexes is { Count: 0 }) return [];
        pixelBudget.Check(pptxPath);
        var outputRoot = Path.GetFullPath(outputDirectory);
        Directory.CreateDirectory(outputRoot);
        var arguments = new List<string> { Path.GetFullPath(pptxPath), outputRoot };
        arguments.AddRange((slideIndexes ?? []).Select(index => index.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        using var result = JsonDocument.Parse(await RunNodeAsync(script, arguments, cancellationToken));
        if (result.RootElement.GetProperty("renderer").GetProperty("name").GetString() != Name)
            throw new InvalidDataException("Preview renderer identity mismatch.");
        var images = result.RootElement.GetProperty("images").EnumerateArray()
            .Select(value => Path.GetFullPath(value.GetString()!)).ToArray();
        if (images.Any(file => !file.StartsWith(outputRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            || !File.Exists(file))) throw new InvalidDataException("Preview image is outside the owned output directory.");
        if (slideIndexes is not null && images.Length != slideIndexes.Count)
            throw new InvalidDataException("Preview selected slide count mismatch.");
        return images;
    }

    private async Task<string> RunNodeAsync(string entry, IReadOnlyList<string> arguments,
        CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        using var process = new Process { StartInfo = new ProcessStartInfo {
            FileName = "node", RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false } };
        process.StartInfo.ArgumentList.Add(entry);
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        process.Start();
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync(deadline.Token); }
        catch (OperationCanceledException) {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(CancellationToken.None);
            await Task.WhenAll(stdout, stderr);
            cancellationToken.ThrowIfCancellationRequested();
            throw new RenderTimeoutException(timeout);
        }
        var errorOutput = await stderr;
        if (process.ExitCode != 0) throw new InvalidOperationException($"ONLYOFFICE preview failed: {errorOutput[..Math.Min(errorOutput.Length, 2000)]}");
        return await stdout;
    }
}
