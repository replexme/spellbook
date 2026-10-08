using System.Diagnostics;
using Spellbook.Document.Core;
using Xunit;

namespace Spellbook.Document.Tests;

public sealed class OnlyOfficeRendererTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), $"spellbook-onlyoffice-{Guid.NewGuid():N}");
    private string Script => Path.Combine(directory, "headless-renderer.mjs");

    public OnlyOfficeRendererTests()
    {
        Directory.CreateDirectory(directory);
        foreach (var name in new[] { "slide-capture.mjs", "distribution/distribution-manifest.json",
            "workspace-dist/sdk.bundle.js", "workspace-dist/workspace-source-receipt.json" })
        {
            var file = Path.Combine(directory, name);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, "identity fixture");
        }
        File.WriteAllText(Script, "");
    }

    [Fact]
    public void HostSourceChangesInvalidateSavedPreviewReuse()
    {
        var previous = new OnlyOfficeRenderer(Script).Version;
        File.WriteAllText(Path.Combine(directory, "workspace-dist/workspace-source-receipt.json"), "changed SDK patch");
        Assert.NotEqual(previous, new OnlyOfficeRenderer(Script).Version);
    }

    [Fact]
    public async Task OutputOutsideTheOwnedDirectoryIsRejected()
    {
        var source = TestPresentationFactory.Create(directory);
        var outside = Path.Combine(directory, "outside.png");
        File.WriteAllText(outside, "fixture");
        File.WriteAllText(Script, "console.log(JSON.stringify({renderer:{name:'ONLYOFFICE'},images:[" +
            System.Text.Json.JsonSerializer.Serialize(outside) + "]}));");
        await Assert.ThrowsAsync<InvalidDataException>(() => new OnlyOfficeRenderer(Script).RenderAsync(
            source, Path.Combine(directory, "slides"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task DeadlineKillsTheOwnedProcessAndKeepsTheWorkerTimeoutCode()
    {
        var source = TestPresentationFactory.Create(directory);
        var pidFile = Path.Combine(directory, "node.pid");
        File.WriteAllText(Script, "import fs from 'node:fs';fs.writeFileSync(" +
            System.Text.Json.JsonSerializer.Serialize(pidFile) + ",String(process.pid));setInterval(()=>{},1000);");
        var failure = await Assert.ThrowsAsync<RenderTimeoutException>(() =>
            new OnlyOfficeRenderer(Script, TimeSpan.FromSeconds(1.5)).RenderAsync(
                source, Path.Combine(directory, "slides"), TestContext.Current.CancellationToken));
        Assert.Equal("render_timeout", WorkerFailure.Code(failure));
        var pid = int.Parse(File.ReadAllText(pidFile));
        Assert.Throws<ArgumentException>(() => Process.GetProcessById(pid));
    }

    public void Dispose() => Directory.Delete(directory, recursive: true);
}
