using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Share2Forget;

public record ChatMessage(
    string Id,
    string Type, // "text" | "file"
    string Sender,
    string SenderId,
    DateTimeOffset SentAt,
    string? Text = null,
    string? FileId = null,
    string? FileName = null,
    long? FileSize = null);

public record FileEntry(string Id, string Name, long Size, string Path);

public class Channel
{
    public required string Code { get; init; }
    public required string Token { get; init; }
    public byte[]? PasswordHash { get; init; }
    public byte[]? PasswordSalt { get; init; }
    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;
    public DateTimeOffset LastActivity { get; set; } = DateTimeOffset.UtcNow;
    public int Connected;
    public List<ChatMessage> Messages { get; } = [];
    public ConcurrentDictionary<string, FileEntry> Files { get; } = new();
    public bool HasPassword => PasswordHash is not null;
}

/// <summary>
/// In-memory channel registry. Nothing survives a restart – that's the "Forget" part.
/// Channel codes are case-sensitive to maximize the usable code space.
/// </summary>
public class ChannelStore
{
    private const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    private const int MaxMessagesPerChannel = 300;

    private readonly ConcurrentDictionary<string, Channel> _channels = new(StringComparer.Ordinal);
    private readonly string _dataDir;

    public ChannelStore(string dataDir)
    {
        _dataDir = dataDir;
        // Uploads from a previous run belong to channels that no longer exist.
        try { if (Directory.Exists(dataDir)) Directory.Delete(dataDir, recursive: true); } catch { }
        Directory.CreateDirectory(dataDir);
    }

    public IEnumerable<Channel> All() => _channels.Values;

    public Channel? Get(string code) =>
        _channels.TryGetValue(code, out var channel) ? channel : null;

    public Channel? GetAuthorized(string code, string? token) =>
        Get(code) is { } channel && !string.IsNullOrEmpty(token) && channel.Token == token
            ? channel
            : null;

    /// <summary>Codes are always generated server-side; retry until one is free.</summary>
    public Channel Create(string? password)
    {
        while (true)
        {
            var channel = Build(GenerateCode(), password);
            if (_channels.TryAdd(channel.Code, channel))
                return channel;
        }
    }

    public bool VerifyPassword(Channel channel, string? password)
    {
        if (!channel.HasPassword) return true;
        if (string.IsNullOrEmpty(password)) return false;
        var hash = Pbkdf2(password, channel.PasswordSalt!);
        return CryptographicOperations.FixedTimeEquals(hash, channel.PasswordHash!);
    }

    public Channel? Delete(string code)
    {
        if (!_channels.TryRemove(code, out var channel)) return null;
        foreach (var file in channel.Files.Values)
            try { File.Delete(file.Path); } catch { }
        return channel;
    }

    public void AddMessage(Channel channel, ChatMessage message)
    {
        lock (channel.Messages)
        {
            channel.Messages.Add(message);
            if (channel.Messages.Count > MaxMessagesPerChannel)
                channel.Messages.RemoveRange(0, channel.Messages.Count - MaxMessagesPerChannel);
        }
        channel.LastActivity = DateTimeOffset.UtcNow;
    }

    public List<ChatMessage> Snapshot(Channel channel)
    {
        lock (channel.Messages) return [.. channel.Messages];
    }

    public string NewFilePath(string fileId) => Path.Combine(_dataDir, fileId);

    private static Channel Build(string code, string? password)
    {
        byte[]? salt = null, hash = null;
        if (!string.IsNullOrEmpty(password))
        {
            salt = RandomNumberGenerator.GetBytes(16);
            hash = Pbkdf2(password, salt);
        }
        return new Channel
        {
            Code = code,
            Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)),
            PasswordHash = hash,
            PasswordSalt = salt,
        };
    }

    private static string GenerateCode()
    {
        Span<char> chars = stackalloc char[5];
        for (var i = 0; i < chars.Length; i++)
            chars[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        return new string(chars);
    }

    private static byte[] Pbkdf2(string password, byte[] salt) =>
        Rfc2898DeriveBytes.Pbkdf2(password, salt, 100_000, HashAlgorithmName.SHA256, 32);
}

public static class Util
{
    public static string CleanName(string? name)
    {
        name = (name ?? "").Trim();
        if (name.Length == 0) return "Anonym";
        return name.Length > 24 ? name[..24] : name;
    }

    public static string CleanFileName(string? name)
    {
        name = Path.GetFileName((name ?? "").Trim());
        if (string.IsNullOrEmpty(name)) return "datei";
        return name.Length > 120 ? name[..120] : name;
    }
}
