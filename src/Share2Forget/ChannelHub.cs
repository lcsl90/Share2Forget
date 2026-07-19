using Microsoft.AspNetCore.SignalR;

namespace Share2Forget;

public class ChannelHub(ChannelStore store) : Hub
{
    private const string JoinedKey = "joined";

    /// <summary>Joins a channel after REST create/join handed out the channel token.</summary>
    public async Task<object> Join(string code, string token, string name)
    {
        var channel = store.GetAuthorized(code, token);
        if (channel is null)
            return new { ok = false, error = "Channel nicht gefunden oder Zugriff verweigert." };

        var joined = Joined();
        var rejoin = joined.ContainsKey(code);
        joined[code] = Util.CleanName(name);
        await Groups.AddToGroupAsync(Context.ConnectionId, code);

        if (!rejoin)
        {
            var count = Interlocked.Increment(ref channel.Connected);
            channel.LastActivity = DateTimeOffset.UtcNow;
            await Clients.Group(code).SendAsync("presence", code, count);
        }

        return new { ok = true, users = channel.Connected, messages = store.Snapshot(channel) };
    }

    public async Task Leave(string code)
    {
        if (!Joined().Remove(code)) return;
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, code);
        await DecrementAsync(code);
    }

    private const int MaxTextLength = 20_000;
    private const int MaxHtmlLength = 100_000;

    public async Task<object> SendMessage(string code, string text, string? html = null)
    {
        if (!Joined().TryGetValue(code, out var name))
            return new { ok = false, error = "Du bist nicht in diesem Channel." };
        if (store.Get(code) is not { } channel)
            return new { ok = false, error = "Diesen Channel gibt es nicht mehr." };

        text = (text ?? "").Trim();
        if (text.Length == 0)
            return new { ok = false, error = "Leere Nachricht." };
        if (text.Length > MaxTextLength)
            return new { ok = false, error = $"Nachricht zu lang (max. {MaxTextLength:N0} Zeichen)." };

        if (string.IsNullOrWhiteSpace(html) || html.Length > MaxHtmlLength)
            html = null;
        else
        {
            html = HtmlSanitizer.Sanitize(html);
            if (string.IsNullOrWhiteSpace(html)) html = null;
        }

        var message = new ChatMessage(
            Guid.NewGuid().ToString("N"), "text", name, Context.ConnectionId,
            DateTimeOffset.UtcNow, Text: text, Html: html);
        store.AddMessage(channel, message);
        await Clients.Group(code).SendAsync("message", code, message);
        return new { ok = true };
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        foreach (var code in Joined().Keys.ToList())
            await DecrementAsync(code);
        await base.OnDisconnectedAsync(exception);
    }

    private async Task DecrementAsync(string code)
    {
        if (store.Get(code) is not { } channel) return;
        var count = Interlocked.Decrement(ref channel.Connected);
        if (count < 0)
        {
            Interlocked.Exchange(ref channel.Connected, 0);
            count = 0;
        }
        channel.LastActivity = DateTimeOffset.UtcNow;
        await Clients.Group(code).SendAsync("presence", code, count);
    }

    private Dictionary<string, string> Joined()
    {
        if (Context.Items.TryGetValue(JoinedKey, out var value) && value is Dictionary<string, string> dict)
            return dict;
        var created = new Dictionary<string, string>();
        Context.Items[JoinedKey] = created;
        return created;
    }
}
