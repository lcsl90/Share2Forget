using System.Text;

namespace Share2Forget;

/// <summary>
/// Whitelist-basierter HTML-Sanitizer ohne externe Abhängigkeiten.
/// Baut die Ausgabe komplett neu aus erkannten, erlaubten Tags auf –
/// alles andere wird encodiert oder verworfen. Die Clients sanitizen
/// zusätzlich beim Rendern (DOM-basiert); das hier ist die zweite
/// Verteidigungslinie und normalisiert die gespeicherten Nachrichten.
/// </summary>
public static class HtmlSanitizer
{
    private static readonly HashSet<string> Allowed = new(StringComparer.OrdinalIgnoreCase)
    {
        "p", "br", "hr", "blockquote", "pre", "ul", "ol", "li",
        "b", "strong", "i", "em", "u", "s", "strike", "del", "code", "a",
        "h1", "h2", "h3", "h4", "mark", "sub", "sup",
        "table", "thead", "tbody", "tr", "th", "td",
    };

    private static readonly HashSet<string> Void = new(StringComparer.OrdinalIgnoreCase) { "br", "hr" };

    /// <summary>Tags, deren kompletter Inhalt entfernt wird.</summary>
    private static readonly HashSet<string> DropContent = new(StringComparer.OrdinalIgnoreCase)
    {
        "script", "style", "iframe", "object", "embed", "svg", "math", "textarea", "noscript", "title", "head",
    };

    private const int MaxDepth = 32;

    public static string Sanitize(string html)
    {
        var output = new StringBuilder(html.Length);
        var stack = new List<string>();
        var i = 0;

        while (i < html.Length)
        {
            var c = html[i];
            if (c != '<')
            {
                AppendText(output, c);
                i++;
                continue;
            }

            if (!TryParseTag(html, i, out var tag, out var end))
            {
                output.Append("&lt;");
                i++;
                continue;
            }

            i = end;

            if (DropContent.Contains(tag.Name) && !tag.Closing && !tag.SelfClosing)
            {
                // Inhalt bis zum passenden schließenden Tag komplett überspringen.
                var close = html.IndexOf("</" + tag.Name, i, StringComparison.OrdinalIgnoreCase);
                if (close < 0) break;
                var gt = html.IndexOf('>', close);
                i = gt < 0 ? html.Length : gt + 1;
                continue;
            }

            if (!Allowed.Contains(tag.Name))
                continue; // Unbekanntes Tag verwerfen, Inhalt bleibt als Text erhalten.

            var name = tag.Name.ToLowerInvariant();
            if (name == "strike") name = "s";

            if (tag.Closing)
            {
                var idx = stack.LastIndexOf(name);
                if (idx < 0) continue;
                for (var j = stack.Count - 1; j >= idx; j--)
                {
                    output.Append("</").Append(stack[j]).Append('>');
                    stack.RemoveAt(j);
                }
                continue;
            }

            if (Void.Contains(name))
            {
                output.Append('<').Append(name).Append('>');
                continue;
            }

            if (stack.Count >= MaxDepth) continue;

            output.Append('<').Append(name);
            AppendAllowedAttributes(output, name, tag.Attributes);
            output.Append('>');
            stack.Add(name);
        }

        for (var j = stack.Count - 1; j >= 0; j--)
            output.Append("</").Append(stack[j]).Append('>');

        return output.ToString();
    }

    private static void AppendText(StringBuilder output, char c)
    {
        switch (c)
        {
            case '>': output.Append("&gt;"); break;
            default: output.Append(c); break;
        }
    }

    private static void AppendAllowedAttributes(StringBuilder output, string name, List<(string Name, string Value)> attributes)
    {
        foreach (var (attr, value) in attributes)
        {
            if (name == "a" && attr.Equals("href", StringComparison.OrdinalIgnoreCase) && IsSafeHref(value))
            {
                output.Append(" href=\"").Append(EncodeAttribute(value)).Append("\" target=\"_blank\" rel=\"noopener noreferrer\"");
            }
            else if (name == "code" && attr.Equals("class", StringComparison.OrdinalIgnoreCase) && IsLanguageClass(value))
            {
                output.Append(" class=\"").Append(EncodeAttribute(value)).Append('"');
            }
        }
    }

    private static bool IsSafeHref(string value) =>
        value.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
        || value.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
        || value.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase);

    private static bool IsLanguageClass(string value)
    {
        if (!value.StartsWith("language-", StringComparison.Ordinal) || value.Length is < 10 or > 40)
            return false;
        foreach (var c in value.AsSpan("language-".Length))
            if (!char.IsAsciiLetterOrDigit(c) && c is not ('+' or '#' or '-' or '.'))
                return false;
        return true;
    }

    private static string EncodeAttribute(string value) =>
        value.Replace("&", "&amp;").Replace("\"", "&quot;").Replace("<", "&lt;").Replace(">", "&gt;");

    private readonly record struct Tag(string Name, bool Closing, bool SelfClosing, List<(string, string)> Attributes);

    /// <summary>Versucht ab <paramref name="start"/> ('&lt;') ein Tag zu parsen.</summary>
    private static bool TryParseTag(string html, int start, out Tag tag, out int end)
    {
        tag = default;
        end = start;
        var i = start + 1;

        var closing = i < html.Length && html[i] == '/';
        if (closing) i++;

        var nameStart = i;
        while (i < html.Length && char.IsAsciiLetterOrDigit(html[i])) i++;
        if (i == nameStart || nameStart >= html.Length || !char.IsAsciiLetter(html[nameStart]))
            return false;
        var name = html[nameStart..i];

        var attributes = new List<(string, string)>();
        var selfClosing = false;

        while (i < html.Length)
        {
            while (i < html.Length && char.IsWhiteSpace(html[i])) i++;
            if (i >= html.Length) return false;

            if (html[i] == '>')
            {
                end = i + 1;
                tag = new Tag(name, closing, selfClosing, attributes);
                return true;
            }
            if (html[i] == '/')
            {
                selfClosing = true;
                i++;
                continue;
            }

            // Attributname
            var attrStart = i;
            while (i < html.Length && html[i] is not ('=' or '>' or '/') && !char.IsWhiteSpace(html[i])) i++;
            if (i == attrStart) return false;
            var attrName = html[attrStart..i];

            while (i < html.Length && char.IsWhiteSpace(html[i])) i++;
            if (i < html.Length && html[i] == '=')
            {
                i++;
                while (i < html.Length && char.IsWhiteSpace(html[i])) i++;
                if (i >= html.Length) return false;

                string value;
                if (html[i] is '"' or '\'')
                {
                    var quote = html[i++];
                    var valueStart = i;
                    while (i < html.Length && html[i] != quote) i++;
                    if (i >= html.Length) return false;
                    value = html[valueStart..i];
                    i++;
                }
                else
                {
                    var valueStart = i;
                    while (i < html.Length && html[i] != '>' && !char.IsWhiteSpace(html[i])) i++;
                    value = html[valueStart..i];
                }
                attributes.Add((attrName, value));
            }
            else
            {
                attributes.Add((attrName, ""));
            }
        }

        return false;
    }
}
