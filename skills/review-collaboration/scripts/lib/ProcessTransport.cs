using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace ReviewCollaboration.Transport
{
    public sealed class DrainResult
    {
        public long Bytes { get; set; }
        public bool Truncated { get; set; }
        public bool Completed { get; set; }
        public string Error { get; set; }
    }

    public sealed class TransportResult
    {
        public string Status { get; set; }
        public int WrapperExitCode { get; set; }
        public bool ProcessStarted { get; set; }
        public int? NativeExitCode { get; set; }
        public bool TimedOut { get; set; }
        public bool StdoutTruncated { get; set; }
        public bool StderrTruncated { get; set; }
        public bool CleanupComplete { get; set; }
        public bool JobCreated { get; set; }
        public bool JobAttached { get; set; }
        public bool TreeTerminated { get; set; }
        public bool ProcessExited { get; set; }
        public bool StdinCompleted { get; set; }
        public bool StdoutCompleted { get; set; }
        public bool StderrCompleted { get; set; }
        public bool StreamWaitTimedOut { get; set; }
        public int OwnedProcessesRemaining { get; set; }
        public long StdoutBytes { get; set; }
        public long StderrBytes { get; set; }
        public string LaunchError { get; set; }
        public string StdinError { get; set; }
        public string StdoutError { get; set; }
        public string StderrError { get; set; }
        public string InputSha256 { get; set; }
        public long InputBytes { get; set; }
        public int TimeoutMs { get; set; }
        public int StreamCapBytes { get; set; }
        public string StdoutPath { get; set; }
        public string StderrPath { get; set; }
    }

    public sealed class OwnedProcessJob : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimits
        {
            public long ProcessTime;
            public long JobTime;
            public uint Flags;
            public UIntPtr MinWorkingSet;
            public UIntPtr MaxWorkingSet;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint Priority;
            public uint Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOps;
            public ulong WriteOps;
            public ulong OtherOps;
            public ulong ReadBytes;
            public ulong WriteBytes;
            public ulong OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemory;
            public UIntPtr JobMemory;
            public UIntPtr PeakProcessMemory;
            public UIntPtr PeakJobMemory;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint infoLength, out uint returnLength);

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicAccounting
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        private IntPtr handle;
        public OwnedProcessJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
            {
                var error = Marshal.GetLastWin32Error();
                Dispose();
                throw new Win32Exception(error);
            }
        }
        public void Attach(IntPtr process)
        {
            if (!AssignProcessToJobObject(handle, process)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        public void Terminate()
        {
            if (handle == IntPtr.Zero) throw new ObjectDisposedException("OwnedProcessJob");
            if (!TerminateJobObject(handle, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        public int ActiveProcessCount()
        {
            if (handle == IntPtr.Zero) throw new ObjectDisposedException("OwnedProcessJob");
            var size = Marshal.SizeOf(typeof(BasicAccounting));
            var buffer = Marshal.AllocHGlobal(size);
            try
            {
                uint returned;
                if (!QueryInformationJobObject(handle, 1, buffer, (uint)size, out returned)) throw new Win32Exception(Marshal.GetLastWin32Error());
                var accounting = (BasicAccounting)Marshal.PtrToStructure(buffer, typeof(BasicAccounting));
                return (int)accounting.ActiveProcesses;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        public bool IsEmpty()
        {
            var status = WaitForSingleObject(handle, 0);
            if (status == 0) return true;
            if (status == 0x102) return false;
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        public void Dispose()
        {
            if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
            GC.SuppressFinalize(this);
        }
        ~OwnedProcessJob() { Dispose(); }
    }

    public static class ProcessTransport
    {
        public const int DefaultStreamCapBytes = 16 * 1024 * 1024;
        private const int CleanupGraceMs = 2000;
        private const int PollMs = 10;
        private const uint CreateSuspended = 0x00000004;
        private const uint CreateNoWindow = 0x08000000;
        private const uint CreateUnicodeEnvironment = 0x00000400;
        private const uint StartfUseStdHandles = 0x00000100;
        private const uint HandleFlagInherit = 0x00000001;
        private const uint WaitObject0 = 0x00000000;
        private const uint WaitTimeout = 0x00000102;
        private const uint Infinite = 0xffffffff;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct SecurityAttributes
        {
            public int Length;
            public IntPtr SecurityDescriptor;
            public bool InheritHandle;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            public int Cb;
            public string Reserved;
            public string Desktop;
            public string Title;
            public int X;
            public int Y;
            public int XSize;
            public int YSize;
            public int XCountChars;
            public int YCountChars;
            public int FillAttribute;
            public uint Flags;
            public short ShowWindow;
            public short Reserved2;
            public IntPtr Reserved2Ptr;
            public IntPtr StdInput;
            public IntPtr StdOutput;
            public IntPtr StdError;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr Process;
            public IntPtr Thread;
            public uint ProcessId;
            public uint ThreadId;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreatePipe")]
        private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
        private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private sealed class NativeProcess : IDisposable
        {
            private IntPtr handle;
            public readonly Stream Input;
            public readonly Stream Output;
            public readonly Stream Error;
            public NativeProcess(IntPtr processHandle, Stream input, Stream output, Stream error)
            {
                handle = processHandle;
                Input = input;
                Output = output;
                Error = error;
            }
            public bool HasExited
            {
                get
                {
                    var status = WaitForSingleObject(handle, 0);
                    if (status == WaitObject0) return true;
                    if (status == WaitTimeout) return false;
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            public int ExitCode
            {
                get
                {
                    uint code;
                    if (!GetExitCodeProcess(handle, out code)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    return unchecked((int)code);
                }
            }
            public void Terminate()
            {
                if (handle != IntPtr.Zero && !TerminateProcess(handle, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            public void Dispose()
            {
                try { if (Input != null) Input.Dispose(); } catch { }
                try { if (Output != null) Output.Dispose(); } catch { }
                try { if (Error != null) Error.Dispose(); } catch { }
                if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
            }
        }

        public static TransportResult Run(string executable, string[] arguments, string workingDirectory, byte[] input, string outputDirectory, int timeoutMs, int streamCapBytes)
        {
            if (String.IsNullOrEmpty(executable)) throw new ArgumentException("executable-required");
            if (arguments == null) arguments = new string[0];
            if (String.IsNullOrEmpty(workingDirectory)) throw new ArgumentException("working-directory-required");
            if (input == null) input = new byte[0];
            if (timeoutMs <= 0) throw new ArgumentOutOfRangeException("timeoutMs");
            if (streamCapBytes <= 0) throw new ArgumentOutOfRangeException("streamCapBytes");
            if (!Directory.Exists(outputDirectory)) throw new DirectoryNotFoundException(outputDirectory);

            var stdoutPath = Path.Combine(outputDirectory, "stdout.bin");
            var stderrPath = Path.Combine(outputDirectory, "stderr.bin");
            var result = new TransportResult();
            result.TimeoutMs = timeoutMs;
            result.StreamCapBytes = streamCapBytes;
            result.InputBytes = input.Length;
            result.InputSha256 = Sha256(input);
            result.StdoutPath = stdoutPath;
            result.StderrPath = stderrPath;

            FileStream stdoutFile = null;
            FileStream stderrFile = null;
            NativeProcess process = null;
            OwnedProcessJob job = null;
            Task<DrainResult> stdoutTask = null;
            Task<DrainResult> stderrTask = null;
            Task<string> stdinTask = null;
            bool terminateRequested = false;
            try
            {
                stdoutFile = new FileStream(stdoutPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 81920, FileOptions.SequentialScan);
                stderrFile = new FileStream(stderrPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 81920, FileOptions.SequentialScan);
                job = new OwnedProcessJob();
                result.JobCreated = true;
                bool processCreated = false;
                bool jobAttached = false;
                bool launchCleanupComplete = false;
                try
                {
                    process = StartOwnedProcess(executable, arguments, workingDirectory, job, out processCreated, out jobAttached, out launchCleanupComplete);
                    result.ProcessStarted = processCreated;
                    result.JobAttached = jobAttached;
                    result.ProcessExited = launchCleanupComplete;
                }
                catch (Exception ex)
                {
                    result.ProcessStarted = processCreated;
                    result.JobAttached = jobAttached;
                    result.ProcessExited = launchCleanupComplete;
                    result.CleanupComplete = launchCleanupComplete;
                    result.LaunchError = ex.ToString();
                    result.Status = "launch-failure";
                    result.WrapperExitCode = 3;
                    return result;
                }

                // Start both drains before writing stdin so a full pipe cannot deadlock the child.
                stdoutTask = Task.Factory.StartNew<DrainResult>(delegate { return Drain(process.Output, stdoutFile, streamCapBytes); }, TaskCreationOptions.LongRunning);
                stderrTask = Task.Factory.StartNew<DrainResult>(delegate { return Drain(process.Error, stderrFile, streamCapBytes); }, TaskCreationOptions.LongRunning);
                stdinTask = Task.Factory.StartNew<string>(delegate { return WriteInput(process.Input, input); }, TaskCreationOptions.LongRunning);

                var watch = Stopwatch.StartNew();
                while (true)
                {
                    if (stdoutTask.IsCompleted && stdoutTask.Result.Truncated) { result.StdoutTruncated = true; terminateRequested = true; break; }
                    if (stderrTask.IsCompleted && stderrTask.Result.Truncated) { result.StderrTruncated = true; terminateRequested = true; break; }
                    int activeProcesses;
                    bool ownedEmpty = IsJobEmpty(job, out activeProcesses);
                    result.OwnedProcessesRemaining = activeProcesses;
                    bool processComplete = process.HasExited && stdinTask.IsCompleted && stdoutTask.IsCompleted && stderrTask.IsCompleted;
                    if (processComplete && ownedEmpty) break;
                    // A parent can exit while an owned descendant still holds a pipe or
                    // remains alive. Clean that tree immediately instead of waiting for the
                    // overall timeout; success still requires the job to become empty.
                    if (processComplete && !ownedEmpty) { terminateRequested = true; break; }
                    if (watch.ElapsedMilliseconds >= timeoutMs) { result.TimedOut = true; terminateRequested = true; break; }
                    Thread.Sleep(PollMs);
                }

                if (terminateRequested)
                {
                    try { job.Terminate(); result.TreeTerminated = true; }
                    catch (Exception ex) { result.LaunchError = Append(result.LaunchError, "terminate:" + ex.Message); }
                    var cleanupWatch = Stopwatch.StartNew();
                    while (cleanupWatch.ElapsedMilliseconds < CleanupGraceMs)
                    {
                        int activeAfterTerminate;
                        bool empty = IsJobEmpty(job, out activeAfterTerminate);
                        result.OwnedProcessesRemaining = activeAfterTerminate;
                        if (process.HasExited && stdinTask.IsCompleted && stdoutTask.IsCompleted && stderrTask.IsCompleted && empty) break;
                        Thread.Sleep(PollMs);
                    }
                }

                result.ProcessExited = process.HasExited;
                result.StdinCompleted = stdinTask.IsCompleted;
                result.StdoutCompleted = stdoutTask.IsCompleted;
                result.StderrCompleted = stderrTask.IsCompleted;
                result.OwnedProcessesRemaining = GetActiveCount(job);
                result.StreamWaitTimedOut = !(result.StdinCompleted && result.StdoutCompleted && result.StderrCompleted);
                if (result.StreamWaitTimedOut) result.LaunchError = Append(result.LaunchError, "bounded-stream-wait-timeout");
                if (stdinTask.IsCompleted) result.StdinError = stdinTask.Result;
                if (stdoutTask.IsCompleted)
                {
                    var captured = stdoutTask.Result;
                    result.StdoutBytes = captured.Bytes;
                    result.StdoutTruncated = result.StdoutTruncated || captured.Truncated;
                    result.StdoutError = captured.Error;
                }
                if (stderrTask.IsCompleted)
                {
                    var captured = stderrTask.Result;
                    result.StderrBytes = captured.Bytes;
                    result.StderrTruncated = result.StderrTruncated || captured.Truncated;
                    result.StderrError = captured.Error;
                }
                if (result.ProcessExited) result.NativeExitCode = process.ExitCode;
                result.CleanupComplete = result.ProcessExited && result.StdinCompleted && result.StdoutCompleted && result.StderrCompleted && result.JobAttached && result.OwnedProcessesRemaining == 0;
                if (result.StdoutTruncated || result.StderrTruncated) { result.Status = "output-cap"; result.WrapperExitCode = 125; }
                else if (result.TimedOut) { result.Status = "timeout"; result.WrapperExitCode = 124; }
                else if (result.StreamWaitTimedOut || !String.IsNullOrEmpty(result.StdinError) || !String.IsNullOrEmpty(result.StdoutError) || !String.IsNullOrEmpty(result.StderrError)) { result.Status = "stream-failure"; result.WrapperExitCode = 125; }
                else if (!result.ProcessExited || !result.CleanupComplete) { result.Status = "cleanup-failure"; result.WrapperExitCode = 126; }
                else if (result.NativeExitCode.HasValue && result.NativeExitCode.Value != 0) { result.Status = "native-nonzero"; result.WrapperExitCode = 10; }
                else { result.Status = "success"; result.WrapperExitCode = 0; }
                return result;
            }
            finally
            {
                if (process != null && result.ProcessStarted && !result.ProcessExited)
                {
                    try
                    {
                        if (result.JobAttached) { job.Terminate(); result.TreeTerminated = true; }
                        else process.Terminate();
                    }
                    catch { }
                }
                if (process != null) process.Dispose();
                if (job != null) job.Dispose();
                if (stdoutFile != null) stdoutFile.Dispose();
                if (stderrFile != null) stderrFile.Dispose();
            }
        }

        private static NativeProcess StartOwnedProcess(string executable, string[] arguments, string workingDirectory, OwnedProcessJob job, out bool processCreated, out bool jobAttached, out bool cleanupComplete)
        {
            processCreated = false;
            jobAttached = false;
            cleanupComplete = false;
            IntPtr stdinRead = IntPtr.Zero;
            IntPtr stdinWrite = IntPtr.Zero;
            IntPtr stdoutRead = IntPtr.Zero;
            IntPtr stdoutWrite = IntPtr.Zero;
            IntPtr stderrRead = IntPtr.Zero;
            IntPtr stderrWrite = IntPtr.Zero;
            IntPtr processHandle = IntPtr.Zero;
            IntPtr threadHandle = IntPtr.Zero;
            Stream input = null;
            Stream output = null;
            Stream error = null;
            try
            {
                var attributes = new SecurityAttributes();
                attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
                attributes.InheritHandle = true;
                if (!CreatePipe(out stdinRead, out stdinWrite, ref attributes, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "stdin-pipe-create-failed");
                if (!CreatePipe(out stdoutRead, out stdoutWrite, ref attributes, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "stdout-pipe-create-failed");
                if (!CreatePipe(out stderrRead, out stderrWrite, ref attributes, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "stderr-pipe-create-failed");
                if (!SetHandleInformation(stdinWrite, HandleFlagInherit, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "stdin-parent-handle-failed");
                if (!SetHandleInformation(stdoutRead, HandleFlagInherit, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "stdout-parent-handle-failed");
                if (!SetHandleInformation(stderrRead, HandleFlagInherit, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "stderr-parent-handle-failed");

                var startup = new StartupInfo();
                startup.Cb = Marshal.SizeOf(typeof(StartupInfo));
                startup.Flags = StartfUseStdHandles;
                startup.StdInput = stdinRead;
                startup.StdOutput = stdoutWrite;
                startup.StdError = stderrWrite;
                var processInfo = new ProcessInformation();
                var commandLine = new StringBuilder(BuildCommandLine(executable, arguments));
                var flags = CreateSuspended | CreateNoWindow | CreateUnicodeEnvironment;
                if (!CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, workingDirectory, ref startup, out processInfo)) throw new Win32Exception(Marshal.GetLastWin32Error(), "native-process-create-failed");
                processHandle = processInfo.Process;
                threadHandle = processInfo.Thread;
                processCreated = true;
                CloseAndZero(ref stdinRead);
                CloseAndZero(ref stdoutWrite);
                CloseAndZero(ref stderrWrite);

                // The process is still suspended here. Assigning the handle before ResumeThread
                // closes the spawn-to-ownership race and puts all descendants in this job.
                job.Attach(processHandle);
                jobAttached = true;
                input = new FileStream(new SafeFileHandle(stdinWrite, true), FileAccess.Write, 81920, false); stdinWrite = IntPtr.Zero;
                output = new FileStream(new SafeFileHandle(stdoutRead, true), FileAccess.Read, 81920, false); stdoutRead = IntPtr.Zero;
                error = new FileStream(new SafeFileHandle(stderrRead, true), FileAccess.Read, 81920, false); stderrRead = IntPtr.Zero;
                if (ResumeThread(threadHandle) == Infinite) throw new Win32Exception(Marshal.GetLastWin32Error(), "native-process-resume-failed");
                CloseAndZero(ref threadHandle);
                var process = new NativeProcess(processHandle, input, output, error);
                processHandle = IntPtr.Zero;
                input = null; output = null; error = null;
                return process;
            }
            catch (Exception launchError)
            {
                bool terminateSucceeded = false;
                bool processExited = false;
                bool jobEmpty = !jobAttached;
                if (processHandle != IntPtr.Zero)
                {
                    try
                    {
                        if (jobAttached) { job.Terminate(); terminateSucceeded = true; }
                        else { terminateSucceeded = TerminateProcess(processHandle, 1); }
                    }
                    catch { terminateSucceeded = false; }
                    var cleanupWatch = Stopwatch.StartNew();
                    while (cleanupWatch.ElapsedMilliseconds < CleanupGraceMs)
                    {
                        var waitStatus = WaitForSingleObject(processHandle, 0);
                        processExited = waitStatus == WaitObject0;
                        if (jobAttached)
                        {
                            try { jobEmpty = job.IsEmpty(); } catch { jobEmpty = false; }
                        }
                        if (processExited && jobEmpty) break;
                        Thread.Sleep(PollMs);
                    }
                }
                cleanupComplete = processCreated && terminateSucceeded && processExited && jobEmpty;
                if (!cleanupComplete) throw new InvalidOperationException("owned-launch-cleanup-incomplete", launchError);
                throw launchError;
            }
            finally
            {
                try { if (input != null) input.Dispose(); } catch { }
                try { if (output != null) output.Dispose(); } catch { }
                try { if (error != null) error.Dispose(); } catch { }
                CloseAndZero(ref stdinRead);
                CloseAndZero(ref stdinWrite);
                CloseAndZero(ref stdoutRead);
                CloseAndZero(ref stdoutWrite);
                CloseAndZero(ref stderrRead);
                CloseAndZero(ref stderrWrite);
                CloseAndZero(ref threadHandle);
                CloseAndZero(ref processHandle);
            }
        }

        private static bool IsJobEmpty(OwnedProcessJob job, out int active)
        {
            try
            {
                if (job.IsEmpty()) { active = 0; return true; }
                active = job.ActiveProcessCount();
                return false;
            }
            catch { active = -1; return false; }
        }
        private static int GetActiveCount(OwnedProcessJob job)
        {
            try { return job.IsEmpty() ? 0 : job.ActiveProcessCount(); } catch { return -1; }
        }
        private static void CloseAndZero(ref IntPtr handle)
        {
            if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
        }

        private static string WriteInput(Stream stream, byte[] input)
        {
            try
            {
                using (stream)
                {
                    if (input.Length > 0) stream.Write(input, 0, input.Length);
                    stream.Flush();
                }
                return null;
            }
            catch (Exception ex) { return ex.ToString(); }
        }

        private static DrainResult Drain(Stream source, Stream destination, int cap)
        {
            var result = new DrainResult();
            var buffer = new byte[81920];
            try
            {
                while (true)
                {
                    int read = source.Read(buffer, 0, buffer.Length);
                    if (read <= 0) break;
                    long remaining = cap - result.Bytes;
                    if (remaining <= 0) { result.Truncated = true; break; }
                    int toWrite = (int)Math.Min((long)read, remaining);
                    destination.Write(buffer, 0, toWrite);
                    result.Bytes += toWrite;
                    if (toWrite < read) { result.Truncated = true; break; }
                }
                destination.Flush();
                result.Completed = true;
            }
            catch (Exception ex) { result.Error = ex.ToString(); }
            finally { try { source.Dispose(); } catch { } }
            return result;
        }

        private static string Append(string current, string next)
        {
            if (String.IsNullOrEmpty(current)) return next;
            return current + ";" + next;
        }

        private static string Sha256(byte[] bytes)
        {
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(bytes);
                var builder = new StringBuilder(hash.Length * 2);
                foreach (byte item in hash) builder.Append(item.ToString("x2"));
                return builder.ToString();
            }
        }

        // Windows native argv quoting for CreateProcess; this is not cmd.exe quoting or shell evaluation.
        public static string BuildCommandLine(string[] arguments)
        {
            var builder = new StringBuilder();
            for (int i = 0; i < arguments.Length; i++)
            {
                if (i > 0) builder.Append(' ');
                builder.Append(QuoteWindowsArg(arguments[i] ?? String.Empty));
            }
            return builder.ToString();
        }

        private static string BuildCommandLine(string executable, string[] arguments)
        {
            var builder = new StringBuilder();
            builder.Append(QuoteWindowsArg(executable ?? String.Empty));
            if (arguments != null)
            {
                for (int i = 0; i < arguments.Length; i++)
                {
                    builder.Append(' ');
                    builder.Append(QuoteWindowsArg(arguments[i] ?? String.Empty));
                }
            }
            return builder.ToString();
        }

        private static string QuoteWindowsArg(string value)
        {
            if (value.Length == 0) return "\"\"";
            bool needsQuotes = false;
            for (int i = 0; i < value.Length; i++) if (Char.IsWhiteSpace(value[i]) || value[i] == '\"') { needsQuotes = true; break; }
            if (!needsQuotes) return value;
            var builder = new StringBuilder();
            builder.Append('\"');
            int slashes = 0;
            for (int i = 0; i < value.Length; i++)
            {
                char ch = value[i];
                if (ch == '\\') { slashes++; continue; }
                if (ch == '\"')
                {
                    builder.Append('\\', slashes * 2 + 1);
                    builder.Append('\"');
                    slashes = 0;
                    continue;
                }
                if (slashes > 0) { builder.Append('\\', slashes); slashes = 0; }
                builder.Append(ch);
            }
            if (slashes > 0) builder.Append('\\', slashes * 2);
            builder.Append('\"');
            return builder.ToString();
        }
    }
}
