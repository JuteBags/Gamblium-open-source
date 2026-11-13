# Screenshot of every visible top-level window of one process, composited onto
# the largest one (so bubbles and menus, which are separate windows, are included).
# Uses PrintWindow, so it works when the window is covered by other windows.
param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing @"
using System; using System.Runtime.InteropServices; using System.Drawing; using System.Drawing.Imaging;
using System.Text; using System.Collections.Generic;
public class WinShot {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  class W { public IntPtr h; public RECT r; public RECT vis; }

  public static string Shoot(uint pid, string outPath) {
    SetProcessDPIAware();
    var list = new List<W>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h) || IsIconic(h)) return true;
      RECT r; GetWindowRect(h, out r);
      if (r.R - r.L < 8 || r.B - r.T < 8) return true;
      RECT v; if (DwmGetWindowAttribute(h, 9, out v, 16) != 0) v = r;
      list.Add(new W { h = h, r = r, vis = v });
      return true;
    }, IntPtr.Zero);
    if (list.Count == 0) return "no window";
    W main = list[0];
    foreach (var w in list) if ((w.vis.R - w.vis.L) * (w.vis.B - w.vis.T) > (main.vis.R - main.vis.L) * (main.vis.B - main.vis.T)) main = w;
    // Canvas = union of all windows' visible bounds.
    int L = main.vis.L, T = main.vis.T, R = main.vis.R, B = main.vis.B;
    foreach (var w in list) { L = Math.Min(L, w.vis.L); T = Math.Min(T, w.vis.T); R = Math.Max(R, w.vis.R); B = Math.Max(B, w.vis.B); }
    using (var canvas = new Bitmap(R - L, B - T, PixelFormat.Format32bppArgb))
    using (var g = Graphics.FromImage(canvas)) {
      g.Clear(Color.FromArgb(255, 40, 40, 40));
      // EnumWindows goes top to bottom in z-order: draw the main window first, then the others bottom-up.
      var order = new List<W>(); order.Add(main);
      for (int i = list.Count - 1; i >= 0; i--) if (list[i] != main) order.Add(list[i]);
      foreach (var w in order) {
        int ww = w.r.R - w.r.L, wh = w.r.B - w.r.T;
        using (var bmp = new Bitmap(ww, wh, PixelFormat.Format32bppArgb)) {
          using (var bg = Graphics.FromImage(bmp)) {
            IntPtr dc = bg.GetHdc();
            PrintWindow(w.h, dc, 2);
            bg.ReleaseHdc(dc);
          }
          var src = new Rectangle(w.vis.L - w.r.L, w.vis.T - w.r.T, w.vis.R - w.vis.L, w.vis.B - w.vis.T);
          g.DrawImage(bmp, new Rectangle(w.vis.L - L, w.vis.T - T, src.Width, src.Height), src, GraphicsUnit.Pixel);
        }
      }
      canvas.Save(outPath, ImageFormat.Png);
    }
    return list.Count + " window(s), " + (R - L) + "x" + (B - T);
  }
}
"@
[WinShot]::Shoot([uint32]$ProcessId, $Out)
