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
        private bool _quitting;
        private string _lastKey;
        private readonly ControlForm _form;

        /// <summary>Set by the logon shortcut: tray only, no window.</summary>
        internal static bool Background;

        [STAThread]
        private static void Main(string[] args)
        {
            // A tray app has no console, so an exception here would otherwise
            // disappear and look exactly like "the icon never appeared".
            Paths.Resolve(args);
            for (var i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], "--background", StringComparison.OrdinalIgnoreCase)) Background = true;
            }
            Log("start: " + string.Join(" ", args));
            Log("root=" + Paths.Root);
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp());
                Log("message loop exited cleanly");
            }
            catch (Exception error)
            {
                Log("fatal: " + error);
                MessageBox.Show(error.ToString(), "Remote Agent Bridge failed to start");
            }
        }

        internal static void Log(string message)
        {
            try
            {
                Directory.CreateDirectory(Paths.DataDir);
                File.AppendAllText(
                    Path.Combine(Paths.DataDir, "tray.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine,
                    new UTF8Encoding(false));
            }
            catch { /* logging must never be the reason the app fails */ }
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
            Log("notify icon added: visible=" + _icon.Visible
                + " smallIconSize=" + SystemInformation.SmallIconSize.Width + "x" + SystemInformation.SmallIconSize.Height
                + " iconSize=" + _iconStopped.Width + "x" + _iconStopped.Height);

            _timer = new Timer();
            _timer.Interval = 2000;
            _timer.Tick += delegate { Tick(); };
            _timer.Start();
            Tick();

            // Windows 10 parks new tray icons in the hidden overflow, and a
            // 16px grey dot is not something anyone finds on their own. The
            // balloon is anchored to the icon, so seeing it also proves the
            // icon exists and where it lives.
            _icon.ShowBalloonTip(8000, "Remote Agent Bridge", "托盘图标已就绪，在这里右键可以启动或停止服务。", ToolTipIcon.Info);

            // The tray icon is the convenient surface, not the reliable one:
            // on some machines the shell refuses to register it at all. When
            // launched by hand we open a real window, so there is always a way
            // to start the service. The logon shortcut passes --background.
            if (!Background)
            {
                _form = new ControlForm(this);
                _form.ShowStatus(Probe(), _busy);
                _form.Show();
            }

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
            Log("render: " + StatusText(status));
            if (_form != null) _form.ShowStatus(status, _busy);
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
            Add(_menu, Label("退出并停止服务"), "quit-stop", true);

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
            if (verb != null) item.Click += delegate
            {
                if (verb == "quit") Quit();
                else if (verb == "quit-stop") QuitAndStop();
                else RunScript(verb);
            };
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

        internal bool StartAtLogon { get { return _startAtLogon; } }
        internal bool IsQuitting { get { return _quitting; } }

        /// <summary>Entry point used by the control window's buttons.</summary>
        internal void Run(string verb)
        {
            if (verb == "quit") Quit();
            else if (verb == "quit-stop") QuitAndStop();
            else RunScript(verb);
        }

        internal void SetStartAtLogon(bool value)
        {
            if (value != _startAtLogon) ToggleStartPref();
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
            if (_quitting) return;
            _quitting = true;
            _timer.Stop();
            if (_form != null)
            {
                try { _form.Close(); } catch { /* already gone */ }
            }
            _icon.Visible = false;
            _icon.Dispose();
            ExitThread();
        }

        /// <summary>Quit, but stop the service on the way out. The stop is
        /// fire-and-forget: the spawned PowerShell is an independent process, so
        /// it finishes after this window is gone. Waiting on the UI thread would
        /// freeze the tray for as long as the service takes to shut down.</summary>
        private void QuitAndStop()
        {
            _icon.ShowBalloonTip(1500, "Remote Agent Bridge", "正在停止服务…", ToolTipIcon.Info);
            RunScript("stop");
            var exit = new Timer();
            exit.Interval = 1500;
            exit.Tick += delegate { exit.Stop(); exit.Dispose(); Quit(); };
            exit.Start();
        }

        private static string Clip(string text, int max)
        {
            return text.Length <= max ? text : text.Substring(0, max);
        }

        /// <summary>A coloured dot, drawn rather than shipped as an icon file so
        /// the repository carries no binary and the state is readable at a
        /// glance without hovering. Drawn at the shell's small-icon size, so it
        /// stays sharp at 125% and 150% display scaling.</summary>
        private static Icon MakeIcon(Color colour)
        {
            int size = SystemInformation.SmallIconSize.Width;
            if (size < 16) size = 16;
            using (var bitmap = new Bitmap(size, size))
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.Clear(Color.Transparent);
                // Fill almost the whole cell: at 16px a dot with generous
                // margins reads as an empty square on a dark taskbar.
                float inset = size * 0.06f;
                float diameter = size - inset * 2;
                using (var fill = new SolidBrush(colour))
                using (var edge = new Pen(Color.FromArgb(45, 45, 45), Math.Max(1f, size / 16f)))
                {
                    graphics.FillEllipse(fill, inset, inset, diameter, diameter);
                    graphics.DrawEllipse(edge, inset, inset, diameter, diameter);
                }
                IntPtr handle = bitmap.GetHicon();
                return Icon.FromHandle(handle);
            }
        }
    }

    /// <summary>
    /// A plain window with the same controls as the tray menu.
    ///
    /// It exists because the tray icon is not a dependable surface: on some
    /// machines the shell never registers it, and a control that cannot be
    /// found is not a control. The window always appears when the app is
    /// started by hand; the logon shortcut runs with --background so a login
    /// does not pop a window in the user's face.
    /// </summary>
    internal sealed class ControlForm : Form
    {
        private readonly TrayApp _app;
        private readonly Label _status;
        private readonly Label _hint;
        private readonly Button _start;
        private readonly Button _stop;
        private readonly Button _restart;
        private readonly Button _open;
        private readonly CheckBox _auto;

        public ControlForm(TrayApp app)
        {
            _app = app;
            Text = "Remote Agent Bridge";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(392, 214);
            AutoScaleMode = AutoScaleMode.Dpi;
            try { Font = new Font("Microsoft YaHei UI", 9f); } catch { /* fall back to the default font */ }

            _status = new Label();
            _status.SetBounds(20, 18, 352, 42);

            _start = MakeButton("启动", 20, 74, 84, "start");
            _stop = MakeButton("停止", 112, 74, 84, "stop");
            _restart = MakeButton("重启", 204, 74, 84, "restart");
            _open = MakeButton("打开配置页", 296, 74, 76, "open");

            _auto = new CheckBox();
            _auto.SetBounds(20, 118, 352, 24);
            _auto.Text = "开机自动启动服务";
            _auto.Checked = app.StartAtLogon;
            _auto.CheckedChanged += delegate { _app.SetStartAtLogon(_auto.Checked); };

            _hint = new Label();
            _hint.SetBounds(20, 152, 352, 48);
            _hint.ForeColor = Color.FromArgb(116, 124, 138);
            _hint.Text = "关闭这个窗口会退出托盘程序，但不会停止服务。"
                + Environment.NewLine
                + "要连服务一起关，用托盘菜单的「退出并停止服务」。";

            Controls.Add(_status);
            Controls.Add(_start);
            Controls.Add(_stop);
            Controls.Add(_restart);
            Controls.Add(_open);
            Controls.Add(_auto);
            Controls.Add(_hint);

            FormClosing += delegate
            {
                if (!_app.IsQuitting) _app.Run("quit");
            };
        }

        private Button MakeButton(string text, int x, int y, int width, string verb)
        {
            var button = new Button();
            button.Text = text;
            button.SetBounds(x, y, width, 28);
            button.Click += delegate { _app.Run(verb); };
            return button;
        }

        public void ShowStatus(Status status, bool busy)
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action<Status, bool>(ShowStatus), status, busy);
                return;
            }
            if (status.Running)
            {
                _status.Text = status.AgentOnline
                    ? "运行中 · Agent 在线（端口 " + status.Port + "）"
                    : "运行中 · Agent 离线（端口 " + status.Port + "）";
                _status.ForeColor = status.AgentOnline ? Color.FromArgb(31, 138, 92) : Color.FromArgb(198, 110, 0);
            }
            else
            {
                _status.Text = "已停止（端口 " + status.Port + "）";
                _status.ForeColor = Color.FromArgb(120, 126, 138);
            }
            _start.Enabled = !status.Running && !busy;
            _stop.Enabled = status.Running && !busy;
            _restart.Enabled = status.Running && !busy;
            _open.Enabled = !busy;
            _auto.Enabled = !busy;
        }
    }
}
