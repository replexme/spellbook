using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Spellbook.Document.Core;

public sealed class RendererFontEnvironment
{
    private readonly HashSet<string> normalizedFamilies;
    private readonly Func<string, string?> substitutionResolver;

    public RendererFontEnvironment(
        bool available,
        IReadOnlyList<string> families,
        Func<string, string?>? substitutionResolver = null,
        bool embeddedFontsSupported = true)
    {
        Available = available;
        Families = families;
        EmbeddedFontsSupported = embeddedFontsSupported;
        this.substitutionResolver = substitutionResolver ?? (_ => null);
        normalizedFamilies = families
            .SelectMany(SplitAliases)
            .Select(Normalize)
            .Where(family => family.Length > 0)
            .ToHashSet(StringComparer.Ordinal);
    }

    public bool Available { get; }

    public IReadOnlyList<string> Families { get; }

    public bool EmbeddedFontsSupported { get; }

    /// <summary>
    /// The fonts the engine draws a deck with, from its report (present-pptx fonts): the
    /// families it has, and the substitute it drew each missing one with.
    /// </summary>
    public static RendererFontEnvironment FromEngineReport(string report)
    {
        using var document = JsonDocument.Parse(report);
        var available = new List<string>();
        var substitutes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var family in document.RootElement.GetProperty("families").EnumerateObject())
        {
            if (family.Value.GetProperty("available").GetBoolean()) available.Add(family.Name);
            else if (family.Value.GetProperty("substitute").GetString() is { Length: > 0 } substitute)
                substitutes[family.Name] = substitute;
        }
        return new RendererFontEnvironment(true, available, family => substitutes.GetValueOrDefault(family));
    }

    public bool HasFamily(string family) => normalizedFamilies.Contains(Normalize(family));

    public string? ResolveSubstitution(string family)
    {
        if (!Available || HasFamily(family)) return null;
        var resolved = substitutionResolver(family)?.Trim();
        return string.IsNullOrWhiteSpace(resolved) || Normalize(resolved) == Normalize(family)
            ? null
            : resolved;
    }

    private static IEnumerable<string> SplitAliases(string value) =>
        value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    private static string Normalize(string value) => Regex.Replace(
        value.Normalize(NormalizationForm.FormKC).Trim().ToUpperInvariant(),
        @"\s+",
        " ",
        RegexOptions.CultureInvariant);
}

public sealed record FontAudit(
    bool InventoryAvailable,
    IReadOnlyList<string> DeclaredFonts,
    IReadOnlyList<string> MissingFonts,
    IReadOnlyList<FontSubstitution> Substitutions);

public sealed record FontSubstitution(string Original, string Substituted);

public sealed class PptxFontAuditor
{
    private static readonly HashSet<string> FontElementNames = ["latin", "ea", "cs"];

    public FontAudit Audit(string path, RendererFontEnvironment environment)
    {
        using var archive = ZipFile.OpenRead(path);
        var documents = archive.Entries
            .Where(entry => IsRelevantPart(entry.FullName))
            .Select(entry => (entry.FullName, Document: LoadXml(entry)))
            .ToList();
        var scripts = DetectUsedScripts(documents
            .Where(item => item.FullName.StartsWith("ppt/slides/", StringComparison.Ordinal))
            .Select(item => item.Document));
        var declared = documents
            .SelectMany(item => DeclaredFonts(item.Document, item.FullName.StartsWith("ppt/theme/", StringComparison.Ordinal), scripts))
            .Where(IsConcreteFamily)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(family => family, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var embedded = new PptxEmbeddedFontExtractor()
            .ReadUsableFaces(path)
            .Select(face => face.Typeface)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var missing = environment.Available
            ? declared.Where(family => !environment.HasFamily(family)
                && !(environment.EmbeddedFontsSupported && embedded.Contains(family))).ToList()
            : declared.ToList();
        var substitutions = missing
            .Select(original => new FontSubstitution(original, environment.ResolveSubstitution(original) ?? string.Empty))
            .Where(substitution => substitution.Substituted.Length > 0)
            .ToList();
        return new FontAudit(environment.Available, declared, missing, substitutions);
    }

    private static bool IsRelevantPart(string path) =>
        path.Equals("ppt/presentation.xml", StringComparison.Ordinal) ||
        IsXmlPartUnder(path, "ppt/slides/") ||
        IsXmlPartUnder(path, "ppt/slideLayouts/") ||
        IsXmlPartUnder(path, "ppt/slideMasters/") ||
        IsXmlPartUnder(path, "ppt/theme/");

    private static bool IsXmlPartUnder(string path, string prefix) =>
        path.StartsWith(prefix, StringComparison.Ordinal) &&
        path.EndsWith(".xml", StringComparison.Ordinal) &&
        !path.Contains("/_rels/", StringComparison.Ordinal);

    private static IEnumerable<string> DeclaredFonts(XDocument document, bool isTheme, IReadOnlySet<string> usedScripts)
    {
        foreach (var element in document.Descendants())
        {
            if (FontElementNames.Contains(element.Name.LocalName))
            {
                var family = (string?)element.Attribute("typeface");
                if (!string.IsNullOrWhiteSpace(family)) yield return family;
                continue;
            }

            if (isTheme && element.Name.LocalName == "font")
            {
                var script = (string?)element.Attribute("script");
                var family = (string?)element.Attribute("typeface");
                if (script is not null && usedScripts.Contains(script) && !string.IsNullOrWhiteSpace(family))
                {
                    yield return family;
                }
            }
        }
    }

    private static HashSet<string> DetectUsedScripts(IEnumerable<XDocument> slides)
    {
        var scripts = new HashSet<string>(StringComparer.Ordinal);
        foreach (var character in slides
            .SelectMany(slide => slide.Descendants().Where(element => element.Name.LocalName == "t"))
            .SelectMany(element => element.Value.EnumerateRunes()))
        {
            var value = character.Value;
            if (value is >= 0xAC00 and <= 0xD7AF || value is >= 0x1100 and <= 0x11FF)
            {
                scripts.Add("Hang");
            }
            else if (value is >= 0x3040 and <= 0x30FF)
            {
                scripts.Add("Jpan");
            }
            else if (value is >= 0x4E00 and <= 0x9FFF)
            {
                scripts.Add("Hans");
                scripts.Add("Hant");
            }
            else if (value is >= 0x0600 and <= 0x06FF)
            {
                scripts.Add("Arab");
            }
            else if (value is >= 0x0590 and <= 0x05FF)
            {
                scripts.Add("Hebr");
            }
            else if (value is >= 0x0E00 and <= 0x0E7F)
            {
                scripts.Add("Thai");
            }
            else if (value is >= 0x0900 and <= 0x097F)
            {
                scripts.Add("Deva");
            }
        }
        return scripts;
    }

    private static bool IsConcreteFamily(string value) =>
        !string.IsNullOrWhiteSpace(value) && !value.TrimStart().StartsWith('+');

    private static XDocument LoadXml(ZipArchiveEntry entry)
    {
        using var stream = entry.Open();
        using var reader = XmlReader.Create(stream, new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = 20_000_000
        });
        return XDocument.Load(reader, LoadOptions.None);
    }
}
