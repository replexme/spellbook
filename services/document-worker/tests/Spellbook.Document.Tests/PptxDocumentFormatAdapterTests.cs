using Spellbook.Document.Core;
using Xunit;

namespace Spellbook.Document.Tests;

/// The deck adapter asks the engine program for previews and fonts; a stand-in script answers like it.
public sealed class PptxDocumentFormatAdapterTests : IDisposable
{
    readonly string dir = Directory.CreateTempSubdirectory("pptx-adapter-").FullName;

    public void Dispose() => Directory.Delete(dir, recursive: true);

    string Engine(string body)
    {
        Assert.SkipUnless(OperatingSystem.IsLinux() || OperatingSystem.IsMacOS(), "Needs a POSIX shell.");
        var path = Path.Combine(dir, "engine.sh");
        File.WriteAllText(path, "#!/bin/sh\n" + body);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return path;
    }

    [Fact]
    public async Task DrawsPreviewsAndChecksFontsWithTheEngine()
    {
        var deck = TestPresentationFactory.Create(dir);
        var adapter = new PptxDocumentFormatAdapter(new PptxSafetyScanner(), new EngineProgram(Engine("""
            case "$1" in
            fonts) echo '{"families":{"Arial":{"available":false,"substitute":"Liberation Sans"},"Noto Sans KR":{"available":true,"substitute":null}}}' ;;
            render-all) mkdir -p "$3" && touch "$3/slide-1.png" && printf '%s\n' "$3/slide-1.png" ;;
            esac
            """), "pptx"));
        var graph = adapter.Inspect(deck, adapter.Scan(deck));
        Assert.True(graph.FontInventoryAvailable);
        var slides = await adapter.RenderAsync(deck, Path.Combine(dir, "slides"), TestContext.Current.CancellationToken);
        Assert.Equal(["slide-1.png"], slides.Select(Path.GetFileName));
        Assert.Equal("Present", adapter.RendererName);
    }

    [Fact]
    public void ReadsTheEngineFontReport()
    {
        var fonts = RendererFontEnvironment.FromEngineReport(
            """{"families":{"Arial":{"available":false,"substitute":"Liberation Sans"},"맑은 고딕":{"available":true,"substitute":null},"Wingdings":{"available":false,"substitute":null}}}""");
        Assert.True(fonts.Available);
        Assert.True(fonts.HasFamily("맑은 고딕"));
        Assert.False(fonts.HasFamily("Arial"));
        Assert.Equal("Liberation Sans", fonts.ResolveSubstitution("Arial"));
        Assert.Null(fonts.ResolveSubstitution("Wingdings"));
    }

    [Fact]
    public void NamesARenderFailureWithoutTheDocument()
    {
        var adapter = new PptxDocumentFormatAdapter(new PptxSafetyScanner(),
            new EngineProgram(Engine("echo 'slide 3: unreadable image' >&2\nexit 1\n"), "pptx"));
        var error = Assert.Throws<InvalidDataException>(() => adapter.RenderAsync("deck.pptx", dir, TestContext.Current.CancellationToken).GetAwaiter().GetResult());
        Assert.Equal("pptx_render-all_failed: slide 3: unreadable image", error.Message);
        Assert.Equal("render_failed", WorkerFailure.Code(error));
    }
}
