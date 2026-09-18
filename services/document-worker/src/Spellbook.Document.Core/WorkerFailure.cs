using System.Text.RegularExpressions;

namespace Spellbook.Document.Core;

/// <summary>
/// Stable reasons for a failed document job. The product UI turns each code
/// into a sentence and a next step; the exception message stays in logs.
/// </summary>
public static partial class WorkerFailure
{
    private static readonly byte[] CompoundFileSignature = [0xD0, 0xCF, 0x11, 0xE0];

    /// <summary>Password-protected OOXML and legacy .ppt are OLE compound files, not ZIP.</summary>
    public static void RejectCompoundFile(string path)
    {
        Span<byte> header = stackalloc byte[4];
        using var stream = File.OpenRead(path);
        if (stream.Read(header) == 4 && header.SequenceEqual(CompoundFileSignature))
            throw new InvalidDataException("encrypted_or_legacy_file");
    }

    public static string Code(Exception exception)
    {
        var message = exception.Message;
        if (exception is InvalidDataException && ReasonCode().IsMatch(message))
            return message;
        if (exception is InvalidDataException &&
            (message.Contains("Central Directory", StringComparison.OrdinalIgnoreCase) ||
             message.Contains("local file header", StringComparison.OrdinalIgnoreCase) ||
             message.Contains("Unsafe ZIP entry", StringComparison.Ordinal) ||
             message.Contains("corrupt", StringComparison.OrdinalIgnoreCase)))
            return "invalid_package";
        if (exception is InvalidDataException &&
            (message.Contains("presentation part", StringComparison.Ordinal) ||
             message.Contains("PowerPoint parts", StringComparison.Ordinal) ||
             message.Contains("presentation relationships", StringComparison.Ordinal) ||
             message.Contains("slide size", StringComparison.Ordinal) ||
             message.Contains("Slide part", StringComparison.Ordinal) ||
             message.Contains("package relationship", StringComparison.Ordinal)))
            return "broken_presentation";
        if (exception is InvalidOperationException &&
            (message.Contains("LibreOffice", StringComparison.Ordinal) ||
             message.Contains("renderer", StringComparison.OrdinalIgnoreCase) ||
             message.Contains("exited with", StringComparison.Ordinal)))
            return "render_failed";
        return "processing_failed";
    }

    [GeneratedRegex("^[a-z][a-z_]*$")]
    private static partial Regex ReasonCode();
}
