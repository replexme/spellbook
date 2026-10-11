using Spellbook.Document.Core;
using Xunit;

namespace Spellbook.Document.Tests;

/// The IDML adapter runs an external engine program; a stand-in script answers like it.
public sealed class IdmlDocumentFormatAdapterTests : IDisposable
{
    readonly string dir = Directory.CreateTempSubdirectory("idml-adapter-").FullName;

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

    const string Sha = "8f6765b5c55b3ac717fb0afbf24825dc3f492a823e5e32daddbd01d2cf99afdf";

    [Fact]
    public async Task ReadsTheEngineAnswersInTheWorkerContract()
    {
        var adapter = new IdmlDocumentFormatAdapter(Engine($$"""
            case "$1" in
            scan) echo '{"contractVersion":"1.0","documentSha256":"{{Sha}}","compressedBytes":10,"uncompressedBytes":20,"entryCount":3,"slideCount":2,"hasExternalRelationships":false,"riskyExternalRelationshipSourceParts":[],"warnings":[]}' ;;
            graph) echo '{"contractVersion":"1.0","documentSha256":"{{Sha}}","slideWidthEmu":7556500,"slideHeightEmu":10680700,"fontInventoryAvailable":false,"declaredFonts":["Minion Pro"],"missingFonts":[],"fontSubstitutions":[],"slides":[{"slideIndex":0,"partUri":"/Spreads/Spread_u1.xml","previewObject":null,"supportGrade":"B","elements":[{"elementId":"0/0","shapeId":299,"kind":"shape","name":"u12b","text":"Title","x":0,"y":0,"width":10,"height":10,"rotation":0,"zIndex":0,"editable":true,"unsupportedReason":null,"sourceHash":"{{Sha}}"}],"warnings":[]}],"warnings":[]}' ;;
            validate) echo '{"contractVersion":"1.0","valid":false,"baselineDocumentSha256":"{{Sha}}","candidateDocumentSha256":"{{Sha}}","changes":[{"part":"Resources/Styles.xml","category":"resources","changeKind":"modified","inTargetScope":false}],"errors":["Resources/Styles.xml: modified resources part is outside what document edits change"]}' ;;
            render-all) mkdir -p "$3" && touch "$3/page-1.png" "$3/page-2.png" && printf '%s\n%s\n' "$3/page-1.png" "$3/page-2.png" ;;
            esac
            """));
        var scan = adapter.Scan("doc.idml");
        Assert.Equal(2, scan.SlideCount);
        var graph = adapter.Inspect("doc.idml", scan);
        Assert.Equal("0/0", graph.Slides[0].Elements[0].ElementId);
        Assert.Equal(299u, graph.Slides[0].Elements[0].ShapeId);
        var report = adapter.Validate("a.idml", "b.idml");
        Assert.False(report.Valid);
        Assert.Single(report.Errors);
        var pages = await adapter.RenderAsync("doc.idml", Path.Combine(dir, "pages"), TestContext.Current.CancellationToken);
        Assert.Equal(["page-1.png", "page-2.png"], pages.Select(Path.GetFileName));
        Assert.Throws<NotSupportedException>(() => adapter.Patch("a", "b", new EditCommandBatch("1.0", Sha, "", [])));
    }

    [Fact]
    public void ReportsTheEngineFailureWithoutTheDocument()
    {
        var adapter = new IdmlDocumentFormatAdapter(Engine("echo 'NotIdml(\"not an IDML package\")' >&2\nexit 1\n"));
        var error = Assert.Throws<InvalidDataException>(() => adapter.Scan("doc.idml"));
        Assert.Equal("idml_scan_failed: NotIdml(\"not an IDML package\")", error.Message);
    }
}
