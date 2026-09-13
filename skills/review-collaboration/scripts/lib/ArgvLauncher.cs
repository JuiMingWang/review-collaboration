using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Threading.Tasks;

// An executable adapter target, not a protocol adapter. The outer Windows Job
// owns this process and every descendant. No shell or terminal scraping.
public static class ArgvLauncher {
    static void Pump(Stream source, Stream destination) {
        var buffer = new byte[81920]; int count;
        while ((count = source.Read(buffer, 0, buffer.Length)) != 0) {
            destination.Write(buffer, 0, count);
            // A session stays open between turns; do not wait for EOF to send
            // a short request or response held in the destination's buffer.
            destination.Flush();
        }
    }
    static string Quote(string value) {
        var text = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') text.Append('\\', slashes * 2 + 1);
            else text.Append('\\', slashes);
            text.Append(c); slashes = 0;
        }
        text.Append('\\', slashes * 2); text.Append('"'); return text.ToString();
    }
    public static int Main(string[] forwarded) {
        string target = Environment.GetEnvironmentVariable("REVIEW_LAUNCH_TARGET");
        string raw = Environment.GetEnvironmentVariable("REVIEW_LAUNCH_ARGV");
        var argv = new List<string>();
        try {
            if (String.IsNullOrEmpty(target) || !Path.IsPathRooted(target) ||
                !target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || raw == null) throw new Exception();
            var items = new JavaScriptSerializer().DeserializeObject(raw) as object[];
            if (items == null) throw new Exception();
            foreach (var item in items) {
                if (!(item is string) || ((string)item).IndexOf('\0') >= 0) throw new Exception();
                argv.Add((string)item);
            }
            argv.AddRange(forwarded);
        } catch { Console.Error.WriteLine("launcher-invalid-configuration"); return 2; }
        if (!File.Exists(target)) { Console.Error.WriteLine("launcher-target-missing"); return 127; }
        var command = new StringBuilder();
        foreach (string arg in argv) { if (command.Length > 0) command.Append(' '); command.Append(Quote(arg)); }
        try {
            var info = new ProcessStartInfo(target, command.ToString());
            info.UseShellExecute = false; info.CreateNoWindow = true;
            info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            using (var child = Process.Start(info)) {
                // Explicit pipes avoid inheriting another writable stdin handle,
                // which can prevent EOF from reaching the child on Windows.
                var input = Task.Run(() => { try { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
                    catch (IOException) { } finally { try { child.StandardInput.Close(); } catch { } } });
                var output = Task.Run(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
                var error = Task.Run(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError()));
                child.WaitForExit();
                if (!Task.WaitAll(new Task[] {output, error}, 5000)) return 125;
                return child.ExitCode;
            }
        } catch { Console.Error.WriteLine("launcher-start-failed"); return 127; }
    }
}
