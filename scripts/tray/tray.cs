// Remote Agent Bridge tray control.
//
// The on-machine answer to "I want to turn this on when I need it": a tray icon
// with start / stop / restart / open-setup, plus a live status line the user can
// read without opening a browser.
//
// Written in C# 5 on purpose. It is compiled by the csc.exe that ships with
// .NET Framework 4, which predates string interpolation, null-conditional
// access and expression-bodied members - so none of those appear here.
//
// The service is deliberately NOT started automatically unless the user ticks
// "开机自动启动服务". The whole point of this app is that "off" is a state you
// can actually be in.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace RabTray
{
    internal sealed class Status
    {
        public bool Running;
        public bool AgentOnline;
        public int Port;
    }

    internal static class Paths
    {
        public static string Root;
        public static string DataDir { get { return Path.Combine(Root, ".rab"); } }
        public static string Script { get { return Path.Combine(Root, "scripts", "rab.ps1"); } }
        public static string Prefs { get { return Path.Combine(DataDir, "tray.json"); } }
        public static string Config { get { return Path.Combine(DataDir, "config.json"); } }

        public static void Resolve(string[] args)
        {
            Root = null;
            for (var i = 0; i < args.Length - 1; i++)
            {
                if (string.Equals(args[i], "--root", StringComparison.OrdinalIgnoreCase)) Root = args[i + 1];
            }
            if (Root == null)
            {
                var exeDir = Path.GetDirectoryName(Application.ExecutablePath);
                Root = Path.GetFullPath(Path.Combine(exeDir, ".."));
            }
        }
    }

    internal sealed class TrayApp : ApplicationContext
    {
        private readonly NotifyIcon _icon;
        private readonly ContextMenuStrip _menu;
        private readonly Timer _timer;
        private readonly Icon _iconRunning;
        private readonly Icon _iconDegraded;
        private readonly Icon _iconStopped;
        private bool _startAtLogon;
        private bool _busy;
        private bool _refreshNow = true;
        private string _lastKey;

        [STAThread]
        private static void Main(string[] args)
        {
            Paths.Resolve(args);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApp());
        }

        public TrayApp()
        {
            _iconRunning = MakeIcon(Color.FromArgb(46, 125, 50));
            _iconDegraded = MakeIcon(Color.FromArgb(239, 108, 0));
            _iconStopped = MakeIcon(Color.FromArgb(158, 158, 158));
            _startAtLogon = ReadStartPref();

            _menu = new ContextMenuStrip();
            _icon = new NotifyIcon();
            _icon.ContextMenuStrip = _menu;
            _icon.Icon = _iconStopped;
            _icon.Text = "Remote Agent Bridge";
            _icon.Visible = true;
            _icon.DoubleClick += delegate { RunScript("open"); };

            _timer = new Timer();
            _timer.Interval = 2000;
            _timer.Tick += delegate { Tick(); };
            _timer.Start();
            Tick();

            // Honouring the preference is the only path that ever starts the
            // service without the user clicking something.
            if (_startAtLogon) RunScript("start");
        }

        private void Tick()
        {
            if (_busy && !_refreshNow) return;
            var status = Probe();
            var key = (status.Running ? "on" : "off") + (status.AgentOnline ? "/agent" : "/noagent") + (_busy ? "/busy" : "");
            if (key != _lastKey || _refreshNow)
            {
                _lastKey = key;
                _refreshNow = false;
                Render(status);
            }
        }

        private void Render(Status status)
        {
            _menu.Items.Clear();
            _menu.Items.Add(Label(StatusText(status)));
            _menu.Items.Add(new ToolStripSeparator());
            Add(_menu, Label("启动"), "start", !status.Running && !_busy);
            Add(_menu, Label("停止"), "stop", status.Running && !_busy);
            Add(_menu, Label("重启"), "restart", status.Running && !_busy);
            Add(_menu, Label("打开配置页"), "open", true);
            _menu.Items.Add(new ToolStripSeparator());
            var pref = new ToolStripMenuItem("开机自动启动服务");
            pref.Checked = _startAtLogon;
            pref.Click += delegate { ToggleStartPref(); };
            _menu.Items.Add(pref);
            _menu.Items.Add(new ToolStripSeparator());
            Add(_menu, Label("退出"), "quit", true);

            _icon.Icon = !status.Running ? _iconStopped : (status.AgentOnline ? _iconRunning : _iconDegraded);
            _icon.Text = Clip(StatusText(status), 63);
        }

        private static ToolStripMenuItem Label(string text)
        {
            var item = new ToolStripMenuItem(text);
            item.Enabled = false;
            return item;
        }

        private void Add(ContextMenuStrip menu, ToolStripMenuItem item, string verb, bool enabled)
        {
            item.Enabled = enabled;
            if (verb != null) item.Click += delegate { if (verb == "quit") Quit(); else RunScript(verb); };
            menu.Items.Add(item);
        }

        private static string StatusText(Status status)
        {
            if (!status.Running) return "已停止 (端口 " + status.Port + ")";
            if (status.AgentOnline) return "运行中 · Agent 在线 (端口 " + status.Port + ")";
            return "运行中 · Agent 离线 (端口 " + status.Port + ")";
        }

        private Status Probe()
        {
            var status = new Status();
            status.Port = ReadPort();
            try
            {
                var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + status.Port + "/health");
                request.Timeout = 800;
                request.ReadWriteTimeout = 800;
                // The operator commonly has a system-wide proxy configured; a
                // loopback health probe must never be routed through it.
                request.Proxy = null;
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                {
                    var body = reader.ReadToEnd();
                    status.Running = true;
                    status.AgentOnline = body.IndexOf("\"agentOnline\":true", StringComparison.Ordinal) >= 0;
                }
            }
            catch
            {
                status.Running = false;
            }
            return status;
        }

        private static int ReadPort()
        {
            try
            {
                var match = Regex.Match(File.ReadAllText(Paths.Config), "\"port\"\\s*:\\s*(\\d+)");
                if (match.Success)
                {
                    int port;
                    if (int.TryParse(match.Groups[1].Value, out port) && port > 0 && port < 65536) return port;
                }
            }
            catch { /* first run: no config yet */ }
            return 8787;
        }

        private void RunScript(string verb)
        {
            if (_busy) return;
            _busy = true;
            _refreshNow = true;
            Render(Probe());
            try
            {
                var psi = new ProcessStartInfo(
                    "powershell.exe",
                    "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + Paths.Script + "\" " + verb);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WorkingDirectory = Paths.Root;
                var child = Process.Start(psi);
                if (child == null) { _busy = false; return; }
                child.EnableRaisingEvents = true;
                child.Exited += delegate { _busy = false; _refreshNow = true; };
                if (child.HasExited) { _busy = false; _refreshNow = true; }
            }
            catch (Exception error)
            {
                _busy = false;
                _refreshNow = true;
                _icon.ShowBalloonTip(4000, "Remote Agent Bridge", "操作失败：" + error.Message, ToolTipIcon.Error);
            }
        }

        private void ToggleStartPref()
        {
            _startAtLogon = !_startAtLogon;
            try
            {
                Directory.CreateDirectory(Paths.DataDir);
                File.WriteAllText(
                    Paths.Prefs,
                    "{\n  \"startServiceAtLogon\": " + (_startAtLogon ? "true" : "false") + "\n}\n",
                    new UTF8Encoding(false));
            }
            catch (Exception error)
            {
                _icon.ShowBalloonTip(4000, "Remote Agent Bridge", "保存设置失败：" + error.Message, ToolTipIcon.Warning);
            }
            _refreshNow = true;
        }

        private static bool ReadStartPref()
        {
            try
            {
                var match = Regex.Match(File.ReadAllText(Paths.Prefs), "\"startServiceAtLogon\"\\s*:\\s*(true|false)");
                return match.Success && match.Groups[1].Value == "true";
            }
            catch { return false; }
        }

        private void Quit()
        {
            _timer.Stop();
            _icon.Visible = false;
            _icon.Dispose();
            ExitThread();
        }

        private static string Clip(string text, int max)
        {
            return text.Length <= max ? text : text.Substring(0, max);
        }

        /// <summary>A coloured dot, drawn rather than shipped as an icon file so
        /// the repository carries no binary and the state is readable at a
        /// glance without hovering.</summary>
        private static Icon MakeIcon(Color colour)
        {
            using (var bitmap = new Bitmap(16, 16))
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.Clear(Color.Transparent);
                using (var fill = new SolidBrush(colour))
                using (var edge = new Pen(Color.FromArgb(70, 70, 70)))
                {
                    graphics.FillEllipse(fill, 1, 1, 13, 13);
                    graphics.DrawEllipse(edge, 1, 1, 13, 13);
                }
                IntPtr handle = bitmap.GetHicon();
                return Icon.FromHandle(handle);
            }
        }
    }
}
