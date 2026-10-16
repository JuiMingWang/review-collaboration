using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// Starts one child at Low integrity with this process's standard handles, cwd
// and environment. Windows then refuses the whole child tree any write to
// medium-labelled objects (ordinary user files); only folders explicitly
// labelled low stay writable. A nested kill-on-close Job ends the low tree when
// this launcher exits. Loaded in memory by low-integrity-launch.ps1 (Add-Type);
// no executable is produced.
namespace ReviewCollaboration.Launch
{
    public static class LowIntegrityLauncher
    {
        const uint TOKEN_ASSIGN_PRIMARY = 0x1, TOKEN_DUPLICATE = 0x2, TOKEN_QUERY = 0x8, TOKEN_ADJUST_DEFAULT = 0x80;
        const uint MAXIMUM_ALLOWED = 0x02000000;
        const int SecurityImpersonation = 2, TokenPrimary = 1, TokenIntegrityLevel = 25;
        const uint SE_GROUP_INTEGRITY = 0x20, STARTF_USESTDHANDLES = 0x100;
        const uint CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_SUSPENDED = 0x4;
        const uint INFINITE = 0xFFFFFFFF, HANDLE_FLAG_INHERIT = 1;
        const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
        const int JobObjectExtendedLimitInformation = 9;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        const string LowIntegritySid = "S-1-16-4096";

        [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
        [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO
        {
            public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }
        [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
            public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr t, uint access, IntPtr attrs, int imp, int type, out IntPtr newTok);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr t, int cls, IntPtr info, int len);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
        [DllImport("advapi32.dll")] static extern int GetLengthSid(IntPtr sid);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int n);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int len);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);

        // CommandLineToArgvW-compatible quoting: each argument stays one argument.
        static string Quote(string a)
        {
            if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
            var sb = new StringBuilder("\"");
            int bs = 0;
            foreach (char c in a)
            {
                if (c == '\\') { bs++; continue; }
                if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
                sb.Append('\\', bs); bs = 0; sb.Append(c);
            }
            sb.Append('\\', bs * 2);
            sb.Append('"');
            return sb.ToString();
        }

        static Exception Fail(string what) { return new Win32Exception(Marshal.GetLastWin32Error(), what); }

        public static int Run(string exe, string[] args)
        {
            IntPtr self, tok = IntPtr.Zero, sid = IntPtr.Zero, labelBuf = IntPtr.Zero, job = IntPtr.Zero, jobInfo = IntPtr.Zero;
            PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
            try
            {
                if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, out self)) throw Fail("OpenProcessToken");
                bool ok = DuplicateTokenEx(self, MAXIMUM_ALLOWED, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out tok);
                int err = Marshal.GetLastWin32Error();
                CloseHandle(self);
                if (!ok) throw new Win32Exception(err, "DuplicateTokenEx");
                if (!ConvertStringSidToSid(LowIntegritySid, out sid)) throw Fail("ConvertStringSidToSid");
                TOKEN_MANDATORY_LABEL tml = new TOKEN_MANDATORY_LABEL();
                tml.Label.Sid = sid; tml.Label.Attributes = SE_GROUP_INTEGRITY;
                int size = Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)) + GetLengthSid(sid);
                labelBuf = Marshal.AllocHGlobal(size);
                Marshal.StructureToPtr(tml, labelBuf, false);
                if (!SetTokenInformation(tok, TokenIntegrityLevel, labelBuf, size)) throw Fail("SetTokenInformation");

                StringBuilder cmd = new StringBuilder(Quote(exe));
                foreach (string a in args) { cmd.Append(' '); cmd.Append(Quote(a)); }

                IntPtr hin = GetStdHandle(STD_INPUT_HANDLE), hout = GetStdHandle(STD_OUTPUT_HANDLE), herr = GetStdHandle(STD_ERROR_HANDLE);
                foreach (IntPtr h in new IntPtr[] { hin, hout, herr })
                    if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
                STARTUPINFO si = new STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                si.dwFlags = (int)STARTF_USESTDHANDLES;
                si.hStdInput = hin; si.hStdOutput = hout; si.hStdError = herr;

                // Environment and cwd are inherited from this launcher, which the
                // caller started with the route's settings.
                if (!CreateProcessAsUser(tok, exe, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED, IntPtr.Zero, null, ref si, out pi))
                    throw Fail("CreateProcessAsUser");

                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) { TerminateProcess(pi.hProcess, 125); throw Fail("CreateJobObject"); }
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION li = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                li.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                int jsz = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                jobInfo = Marshal.AllocHGlobal(jsz);
                Marshal.StructureToPtr(li, jobInfo, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, jobInfo, jsz)) { TerminateProcess(pi.hProcess, 125); throw Fail("SetInformationJobObject"); }
                if (!AssignProcessToJobObject(job, pi.hProcess)) { TerminateProcess(pi.hProcess, 125); throw Fail("AssignProcessToJobObject"); }
                if (ResumeThread(pi.hThread) == 0xFFFFFFFF) { TerminateProcess(pi.hProcess, 125); throw Fail("ResumeThread"); }
                CloseHandle(pi.hThread); pi.hThread = IntPtr.Zero;

                WaitForSingleObject(pi.hProcess, INFINITE);
                uint code;
                if (!GetExitCodeProcess(pi.hProcess, out code)) throw Fail("GetExitCodeProcess");
                return unchecked((int)code);
            }
            finally
            {
                if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
                if (job != IntPtr.Zero) CloseHandle(job);
                if (tok != IntPtr.Zero) CloseHandle(tok);
                if (sid != IntPtr.Zero) LocalFree(sid);
                if (labelBuf != IntPtr.Zero) Marshal.FreeHGlobal(labelBuf);
                if (jobInfo != IntPtr.Zero) Marshal.FreeHGlobal(jobInfo);
            }
        }
    }
}
