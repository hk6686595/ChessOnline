# gen-audio.ps1 - Generate client audio assets (re-runnable).
#   Outputs (into client\XiangqiClient\Assets):
#     move.wav      - dry woodblock luozi (ORIGINAL, Tiantian-Xiangqi-like character)
#     capture.wav   - heavier wood hit for captures
#     select.wav    - light tick when picking a piece
#     check.wav     - clack + short alert for check
#     mate.wav      - gong slam for checkmate
#     win.wav       - ascending pentatonic fanfare for the winner (ORIGINAL)
#     bgm.wav       - warm Jiangnan-style plucked loop (ORIGINAL)
# Voice clips (eat / check) are generated separately: tools\gen-voice.ps1
# Drop your own bgm.mp3 / move.wav / capture.wav next to the exe to override.
# IMPORTANT: keep this file ASCII-only so it parses correctly on any PowerShell.
$ErrorActionPreference = 'Stop'

$cs = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

public static class AudioGen
{
    private static readonly Dictionary<string, double> F = new Dictionary<string, double>
    {
        { "G2", 98.00 }, { "A2", 110.00 }, { "C3", 130.81 }, { "D3", 146.83 }, { "E3", 164.81 },
        { "G3", 196.00 }, { "A3", 220.00 }, { "C4", 261.63 }, { "D4", 293.66 }, { "E4", 329.63 },
        { "G4", 392.00 }, { "A4", 440.00 }, { "B4", 493.88 },
        { "C5", 523.25 }, { "D5", 587.33 }, { "E5", 659.26 }, { "G5", 783.99 }, { "A5", 880.00 },
        { "C6", 1046.50 }, { "D6", 1174.66 }, { "E6", 1318.51 }, { "G6", 1567.98 },
    };

    public static void GenerateAll(string dir)
    {
        Directory.CreateDirectory(dir);
        GenMove(Path.Combine(dir, "move.wav"));
        GenCapture(Path.Combine(dir, "capture.wav"));
        GenSelect(Path.Combine(dir, "select.wav"));
        GenCheck(Path.Combine(dir, "check.wav"));
        GenMate(Path.Combine(dir, "mate.wav"));
        GenWin(Path.Combine(dir, "win.wav"));
        GenBgm(Path.Combine(dir, "bgm.wav"));
    }

    private static void WriteWav(string path, int sr, float[] s)
    {
        using (FileStream fs = File.Create(path))
        using (BinaryWriter bw = new BinaryWriter(fs))
        {
            int dataSize = s.Length * 2;
            bw.Write(Encoding.ASCII.GetBytes("RIFF"));
            bw.Write(36 + dataSize);
            bw.Write(Encoding.ASCII.GetBytes("WAVE"));
            bw.Write(Encoding.ASCII.GetBytes("fmt "));
            bw.Write(16);
            bw.Write((short)1);
            bw.Write((short)1);
            bw.Write(sr);
            bw.Write(sr * 2);
            bw.Write((short)2);
            bw.Write((short)16);
            bw.Write(Encoding.ASCII.GetBytes("data"));
            bw.Write(dataSize);
            foreach (float v in s)
            {
                int x = (int)(Math.Max(-1.0f, Math.Min(1.0f, v)) * 32767);
                bw.Write((short)x);
            }
        }
    }

    // Guzheng / plucked silk: many harmonics, inharmonic stretch, longer low-note ring.
    private static float[] Pluck(double freq, double sr, double dur, double amp, double attack)
    {
        int n = (int)Math.Ceiling(dur * sr);
        float[] buf = new float[n];
        double decBase = 4.8 * Math.Sqrt(freq / 330.0);
        for (int i = 0; i < n; i++)
        {
            double t = i / sr;
            double env = t < attack ? t / attack : 1.0;
            double v = 0.0;
            for (int k = 1; k <= 8; k++)
            {
                double fk = freq * k * (1.0 + 0.00035 * k * k);
                v += (1.0 / Math.Pow(k, 1.15)) * Math.Sin(2.0 * Math.PI * fk * t)
                    * Math.Exp(-t * (decBase + 2.2 * k));
            }
            buf[i] = (float)(v * env * amp);
        }
        return buf;
    }

    // Wooden chess-piece clack: damped board modes + a few ms of impact noise.
    private static float[] WoodClack(double sr, double dur, double[] freqs, double[] decays, double[] amps,
        double noiseAmp, double noiseDecay, int seed)
    {
        int n = (int)Math.Ceiling(dur * sr);
        float[] buf = new float[n];
        Random rng = new Random(seed);
        for (int i = 0; i < n; i++)
        {
            double t = i / sr;
            double v = 0.0;
            for (int k = 0; k < freqs.Length; k++)
                v += amps[k] * Math.Sin(2.0 * Math.PI * freqs[k] * t) * Math.Exp(-t * decays[k]);
            v += noiseAmp * (rng.NextDouble() * 2.0 - 1.0) * Math.Exp(-t * noiseDecay);
            buf[i] = (float)v;
        }
        return buf;
    }

    private static void AddAt(float[] dst, float[] src, double startSec, double sr)
    {
        int start = (int)Math.Floor(startSec * sr);
        for (int i = 0; i < src.Length; i++)
        {
            int idx = start + i;
            if (idx >= dst.Length) break;
            if (idx < 0) continue;
            dst[idx] += src[i];
        }
    }

    private static void Normalize(float[] buf, float peak)
    {
        float m = 0f;
        for (int i = 0; i < buf.Length; i++)
        {
            float a = Math.Abs(buf[i]);
            if (a > m) m = a;
        }
        if (m <= 0f) return;
        float scale = peak / m;
        for (int i = 0; i < buf.Length; i++) buf[i] *= scale;
    }

    private static void FadeOut(float[] buf, double sr, double dur)
    {
        int n = (int)Math.Min(dur * sr, buf.Length);
        for (int i = 0; i < n; i++)
            buf[buf.Length - 1 - i] *= (float)(i / (double)n);
    }

    // Dry woodblock-like luozi (ORIGINAL, not a commercial sample).
    // Two micro-impacts + bright inharmonic wood modes, short tail.
    private static void AddLuoziHit(float[] dst, double sr, double at, double amp, bool thud, int seed)
    {
        double[] freqs, decays, amps;
        double noiseAmp, noiseDecay, hp;
        if (thud)
        {
            freqs = new double[] { 210, 370, 620 };
            decays = new double[] { 26, 34, 50 };
            amps = new double[] { 0.72, 0.42, 0.18 };
            noiseAmp = 0.32; noiseDecay = 95; hp = 160;
        }
        else
        {
            freqs = new double[] { 1640, 2380, 3120, 3980, 5480 };
            decays = new double[] { 78, 95, 118, 150, 190 };
            amps = new double[] { 0.34, 0.78, 0.42, 0.20, 0.09 };
            noiseAmp = 0.82; noiseDecay = 240; hp = 1750;
        }
        int n = (int)Math.Ceiling(0.09 * sr);
        float[] hit = new float[n];
        Random rng = new Random(seed);
        double prevX = 0, prevY = 0;
        double rc = 1.0 / (2.0 * Math.PI * hp);
        double dt = 1.0 / sr;
        double ahp = rc / (rc + dt);
        for (int i = 0; i < n; i++)
        {
            double t = i / sr;
            double v = 0.0;
            for (int k = 0; k < freqs.Length; k++)
                v += amps[k] * Math.Sin(2.0 * Math.PI * freqs[k] * t) * Math.Exp(-t * decays[k]);
            double x = (rng.NextDouble() * 2.0 - 1.0) * Math.Exp(-t * noiseDecay);
            double y = ahp * (prevY + x - prevX);
            prevX = x; prevY = y;
            hit[i] = (float)((v + noiseAmp * y) * amp);
        }
        AddAt(dst, hit, at, sr);
    }

    private static float[] Luozi(double sr, bool capture)
    {
        float[] buf = new float[(int)((capture ? 0.125 : 0.080) * sr)];
        AddLuoziHit(buf, sr, 0.0000, capture ? 1.00 : 0.96, false, 11);
        AddLuoziHit(buf, sr, 0.0029, capture ? 0.52 : 0.40, false, 19);
        if (capture)
        {
            AddLuoziHit(buf, sr, 0.0000, 0.58, true, 31);
            AddLuoziHit(buf, sr, 0.0125, 0.68, false, 41);
        }
        Normalize(buf, capture ? 0.93f : 0.90f);
        FadeOut(buf, sr, 0.008);
        return buf;
    }

    // Short bright wood "da" (~80 ms), classic online-xiangqi luozi character.
    private static void GenMove(string path)
    {
        int sr = 44100;
        WriteWav(path, sr, Luozi(sr, false));
    }

    // Same family plus a low knock (capture).
    private static void GenCapture(string path)
    {
        int sr = 44100;
        WriteWav(path, sr, Luozi(sr, true));
    }

    // Light pickup tick.
    private static void GenSelect(string path)
    {
        int sr = 44100;
        float[] buf = new float[(int)(0.048 * sr)];
        AddLuoziHit(buf, sr, 0.0000, 0.55, false, 7);
        Normalize(buf, 0.48f);
        FadeOut(buf, sr, 0.005);
        WriteWav(path, sr, buf);
    }

    // Luozi plus two pentatonic pings (check warning).
    private static void GenCheck(string path)
    {
        int sr = 44100;
        float[] buf = new float[(int)(0.42 * sr)];
        AddAt(buf, Luozi(sr, false), 0.0, sr);
        AddAt(buf, Pluck(783.99, sr, 0.32, 0.55, 0.004), 0.04, sr);
        AddAt(buf, Pluck(1046.50, sr, 0.28, 0.40, 0.004), 0.09, sr);
        Normalize(buf, 0.82f);
        FadeOut(buf, sr, 0.04);
        WriteWav(path, sr, buf);
    }

    // Inharmonic gong-like strike (luo), for checkmate sting.
    private static float[] Gong(double sr, double dur, double baseHz, double amp)
    {
        int n = (int)Math.Ceiling(dur * sr);
        float[] buf = new float[n];
        double[] ratios = { 1.00, 1.47, 2.09, 2.56, 3.14, 4.21 };
        double[] amps = { 1.00, 0.62, 0.38, 0.24, 0.14, 0.08 };
        double[] decays = { 3.2, 4.5, 6.0, 7.5, 9.0, 11.0 };
        for (int i = 0; i < n; i++)
        {
            double t = i / sr;
            double v = 0.0;
            for (int k = 0; k < ratios.Length; k++)
                v += amps[k] * Math.Sin(2.0 * Math.PI * baseHz * ratios[k] * t) * Math.Exp(-t * decays[k]);
            buf[i] = (float)(v * amp);
        }
        return buf;
    }

    // Checkmate: slam + gong + descending sting, much louder/longer than check.
    private static void GenMate(string path)
    {
        int sr = 44100;
        float[] buf = new float[(int)(1.55 * sr)];
        AddAt(buf, WoodClack(sr, 0.22,
            new double[] { 140, 280, 620, 1180, 2100 },
            new double[] { 18, 24, 40, 58, 85 },
            new double[] { 0.85, 0.55, 0.35, 0.22, 0.10 },
            0.75, 80, 41), 0.0, sr);
        AddAt(buf, Gong(sr, 1.35, 196.0, 0.85), 0.03, sr);
        AddAt(buf, Gong(sr, 1.10, 261.6, 0.45), 0.08, sr);
        AddAt(buf, Pluck(1174.66, sr, 0.55, 0.72, 0.003), 0.10, sr);
        AddAt(buf, Pluck(783.99, sr, 0.62, 0.78, 0.003), 0.28, sr);
        AddAt(buf, Pluck(523.25, sr, 0.85, 0.88, 0.004), 0.50, sr);
        AddAt(buf, Pluck(196.00, sr, 1.00, 0.70, 0.006), 0.50, sr);
        AddAt(buf, WoodClack(sr, 0.12,
            new double[] { 980, 1480, 2320 },
            new double[] { 42, 55, 78 },
            new double[] { 0.35, 0.22, 0.12 },
            0.35, 130, 13), 0.52, sr);
        Normalize(buf, 0.96f);
        FadeOut(buf, sr, 0.12);
        WriteWav(path, sr, buf);
    }

    // Victory fanfare: bright ascending pentatonic run + final chord (~1.6 s).
    private static void GenWin(string path)
    {
        int sr = 44100;
        float[] buf = new float[(int)(1.7 * sr)];
        string[] notes = { "C5", "D5", "E5", "G5", "A5", "C6" };
        double[] ats = { 0.00, 0.11, 0.22, 0.33, 0.44, 0.56 };
        for (int i = 0; i < notes.Length; i++)
        {
            AddAt(buf, Pluck(F[notes[i]], sr, 0.55, 0.62, 0.003), ats[i], sr);
            AddAt(buf, Karplus(F[notes[i]], sr, 0.45, 0.28), ats[i] + 0.01, sr);
        }
        // Final chord: C major-ish pentatonic stack with a light wood tick
        AddAt(buf, Karplus(F["C5"], sr, 1.05, 0.50), 0.72, sr);
        AddAt(buf, Karplus(F["E5"], sr, 1.00, 0.42), 0.74, sr);
        AddAt(buf, Karplus(F["G5"], sr, 0.95, 0.40), 0.76, sr);
        AddAt(buf, Karplus(F["C6"], sr, 0.90, 0.34), 0.78, sr);
        AddAt(buf, WoodClack(sr, 0.12,
            new double[] { 980, 1480, 2320 },
            new double[] { 42, 55, 78 },
            new double[] { 0.32, 0.20, 0.10 },
            0.30, 130, 17), 0.70, sr);
        Normalize(buf, 0.90f);
        FadeOut(buf, sr, 0.18);
        WriteWav(path, sr, buf);
    }

    private static void FadeIn(float[] buf, double sr, double dur)
    {
        int n = (int)Math.Min(dur * sr, buf.Length);
        if (n <= 1) return;
        for (int i = 0; i < n; i++)
            buf[i] *= (float)(i / (double)n);
    }

    // Karplus-Strong plucked string: warmer and more natural than additive harmonics.
    private static float[] Karplus(double freq, double sr, double dur, double amp)
    {
        int n = Math.Max(32, (int)Math.Ceiling(dur * sr));
        int L = Math.Max(2, (int)Math.Round(sr / freq));
        float[] ring = new float[L];
        Random rng = new Random(((int)(freq * 13) ^ (int)(dur * 1000)) & 0x7fffffff);
        for (int i = 0; i < L; i++)
        {
            double s = Math.Sin(2.0 * Math.PI * i / L);
            ring[i] = (float)(0.40 * s + 0.60 * (rng.NextDouble() * 2.0 - 1.0));
        }
        float damp = (float)(0.9935 + Math.Min(0.0055, 10.0 / freq));
        float[] buf = new float[n];
        int idx = 0;
        float prev = 0f;
        int attackN = Math.Max(1, (int)(0.005 * sr));
        double envDec = 0.28 + freq / 5200.0;
        for (int i = 0; i < n; i++)
        {
            float y = ring[idx];
            double t = i / sr;
            float env = (i < attackN ? i / (float)attackN : 1f) * (float)Math.Exp(-t * envDec);
            buf[i] = y * (float)amp * env;
            float avg = damp * 0.5f * (y + prev);
            prev = y;
            ring[idx] = avg;
            idx++;
            if (idx >= L) idx = 0;
        }
        return buf;
    }

    private static float[] SoftPad(double freq, double sr, double dur, double amp)
    {
        int n = (int)Math.Ceiling(dur * sr);
        float[] buf = new float[n];
        for (int i = 0; i < n; i++)
        {
            double t = i / sr;
            double env = 1.0;
            if (t < 0.12) env = t / 0.12;
            if (t > dur - 0.35 && dur > 0.35) env *= (dur - t) / 0.35;
            double v = Math.Sin(2.0 * Math.PI * freq * t)
                     + 0.18 * Math.Sin(2.0 * Math.PI * freq * 2.0 * t);
            buf[i] = (float)(v * amp * env);
        }
        return buf;
    }

    private static void Lowpass(float[] buf, double sr, double cutoff)
    {
        double rc = 1.0 / (2.0 * Math.PI * cutoff);
        double dt = 1.0 / sr;
        double a = dt / (rc + dt);
        float y = 0f;
        for (int i = 0; i < buf.Length; i++)
        {
            y += (float)(a * (buf[i] - y));
            buf[i] = y;
        }
    }

    private static float[] Reverb(float[] src, double sr)
    {
        int d1 = (int)(0.092 * sr);
        int d2 = (int)(0.171 * sr);
        int d3 = (int)(0.263 * sr);
        float[] dst = new float[src.Length];
        for (int i = 0; i < src.Length; i++)
        {
            float v = src[i];
            if (i >= d1) v += 0.32f * src[i - d1];
            if (i >= d2) v += 0.18f * src[i - d2];
            if (i >= d3) v += 0.10f * src[i - d3];
            dst[i] = v;
        }
        return dst;
    }

    private static string HarmonyOf(string n)
    {
        switch (n)
        {
            case "A5": return "E5";
            case "G5": return "C5";
            case "E5": return "C5";
            case "D5": return "A4";
            case "C5": return "G4";
            case "A4": return "E4";
            case "G4": return "D4";
            default: return "C4";
        }
    }

    private static void AddMel(List<Tuple<string, double>> mel, string n, double b)
    {
        mel.Add(Tuple.Create(n, b));
    }

    // Lyrical original Jiangnan-style loop: warm strings, space between phrases.
    private static void GenBgm(string path)
    {
        int sr = 44100;
        double bpm = 60.0;
        double beat = 60.0 / bpm;
        double total = 64 * beat + 2.0;
        float[] buf = new float[(int)(total * sr)];

        List<Tuple<string, double>> mel = new List<Tuple<string, double>>();
        // Verse: unhurried
        AddMel(mel, "C5", 2); AddMel(mel, "D5", 1); AddMel(mel, "E5", 1);
        AddMel(mel, "G5", 2); AddMel(mel, "E5", 1); AddMel(mel, "D5", 1);
        AddMel(mel, "C5", 1.5); AddMel(mel, "A4", 0.5); AddMel(mel, "C5", 2);
        AddMel(mel, "D5", 3); AddMel(mel, "E5", 1);
        AddMel(mel, "G4", 2); AddMel(mel, "A4", 1); AddMel(mel, "C5", 1);
        AddMel(mel, "D5", 2); AddMel(mel, "C5", 2);
        AddMel(mel, "A4", 1.5); AddMel(mel, "G4", 0.5); AddMel(mel, "A4", 2);
        AddMel(mel, "C5", 4);
        // Chorus: a little more lift
        AddMel(mel, "E5", 1.5); AddMel(mel, "G5", 0.5); AddMel(mel, "A5", 2);
        AddMel(mel, "G5", 1.5); AddMel(mel, "E5", 0.5); AddMel(mel, "D5", 2);
        AddMel(mel, "C5", 1); AddMel(mel, "D5", 1); AddMel(mel, "E5", 2);
        AddMel(mel, "D5", 1); AddMel(mel, "C5", 3);
        AddMel(mel, "E5", 2); AddMel(mel, "D5", 1); AddMel(mel, "C5", 1);
        AddMel(mel, "A4", 2); AddMel(mel, "G4", 2);
        AddMel(mel, "A4", 1); AddMel(mel, "C5", 1); AddMel(mel, "D5", 2);
        AddMel(mel, "C5", 4);

        double t = 0.0;
        foreach (Tuple<string, double> n in mel)
        {
            double f = F[n.Item1];
            double hold = n.Item2 * beat * 2.4;
            AddAt(buf, Karplus(f, sr, hold, 0.50), t, sr);
            AddAt(buf, Karplus(F[HarmonyOf(n.Item1)], sr, hold * 0.95, 0.22), t + 0.03, sr);
            t += n.Item2 * beat;
        }

        string[] roots = {
            "C3","C3","A2","C3","G2","A2","G2","C3",
            "C3","A2","C3","G2","A2","G2","C3","C3"
        };
        string[][] arps = {
            new[] { "C3","G3","C4","E4" },
            new[] { "A2","E3","A3","C4" },
            new[] { "G2","D3","G3","C4" },
        };
        int[] arpPick = { 0,0,1,0, 2,1,2,0, 0,1,0,2, 1,2,0,0 };
        for (int bar = 0; bar < 16; bar++)
        {
            double bt = bar * 4.0 * beat;
            AddAt(buf, Karplus(F[roots[bar]], sr, 3.6, 0.34), bt, sr);
            AddAt(buf, SoftPad(F[roots[bar]], sr, 3.9, 0.045), bt, sr);
            string[] arp = arps[arpPick[bar]];
            for (int k = 0; k < 8; k++)
            {
                string note = arp[k % arp.Length];
                AddAt(buf, Karplus(F[note], sr, 0.9, 0.085), bt + k * 0.5 * beat, sr);
            }
        }

        Lowpass(buf, sr, 4200);
        buf = Reverb(buf, sr);
        Lowpass(buf, sr, 5200);
        Normalize(buf, 0.70f);
        FadeIn(buf, sr, 0.7);
        FadeOut(buf, sr, 1.4);
        WriteWav(path, sr, buf);
    }
}
'@

Add-Type -TypeDefinition $cs

$outDir = (Resolve-Path (Join-Path $PSScriptRoot '..\client\XiangqiClient\Assets')).Path
[AudioGen]::GenerateAll($outDir)
Write-Host "Audio assets generated in $outDir"
