# gen-voice.ps1 - Generate xiangqi announcer clips (eat / check / mate).
# Uses Windows Chinese TTS (prefers Microsoft Kangkang). Re-runnable.
# Outputs: voice-eat.wav, voice-check.wav, voice-mate.wav
$ErrorActionPreference = 'Stop'

$outDir = (Resolve-Path (Join-Path $PSScriptRoot '..\client\XiangqiClient\Assets')).Path
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Foundation, ContentType=WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$synth = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::new()
$kang = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices |
    Where-Object { $_.DisplayName -match 'Kangkang' } | Select-Object -First 1
if ($kang) { $synth.Voice = $kang }
else {
    $zh = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices |
        Where-Object { $_.Language -match '^zh' } | Select-Object -First 1
    if (-not $zh) { throw 'No Chinese TTS voice installed.' }
    $synth.Voice = $zh
}
Write-Host ("TTS voice: {0}" -f $synth.Voice.DisplayName)

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
$await = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])

function Save-Ssml([string]$ssml, [string]$file) {
    $op = $synth.SynthesizeSsmlToStreamAsync($ssml)
    $task = $await.Invoke($null, @($op))
    if (-not $task.Wait(15000)) { throw "TTS timeout: $file" }
    $stream = $task.Result
    $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
    $path = Join-Path $outDir $file
    $fs = [IO.File]::Create($path)
    try { $net.CopyTo($fs) } finally { $fs.Dispose(); $net.Dispose() }
}

# U+5403 = eat, U+5C06 U+519B = jiang-jun, U+7EDD U+6740 = jue-sha
$eatChar = [char]0x5403
$checkText = ([char]0x5C06).ToString() + [char]0x519B
$mateText = ([char]0x7EDD).ToString() + [char]0x6740
Save-Ssml "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><prosody rate='+20%' pitch='-8%' volume='loud'>$eatChar</prosody></speak>" 'voice-eat.wav'
Save-Ssml "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><prosody rate='+8%' pitch='-5%' volume='loud'>$checkText</prosody></speak>" 'voice-check.wav'
Save-Ssml "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><prosody rate='+2%' pitch='-12%' volume='loud'>$mateText</prosody></speak>" 'voice-mate.wav'

$cs = @'
using System;
using System.IO;
using System.Text;

public static class VoiceTrim
{
    public static void Process(string path, float peak, double padMs)
    {
        byte[] raw = File.ReadAllBytes(path);
        int pos = 12;
        int channels = 1, sr = 16000, bps = 16;
        byte[] data = null;
        while (pos + 8 <= raw.Length)
        {
            string id = Encoding.ASCII.GetString(raw, pos, 4);
            int size = BitConverter.ToInt32(raw, pos + 4);
            int start = pos + 8;
            if (id == "fmt ")
            {
                channels = BitConverter.ToInt16(raw, start + 2);
                sr = BitConverter.ToInt32(raw, start + 4);
                bps = BitConverter.ToInt16(raw, start + 14);
            }
            else if (id == "data")
            {
                data = new byte[size];
                Array.Copy(raw, start, data, 0, size);
                break;
            }
            pos = start + size + (size % 2);
        }
        if (data == null || bps != 16) throw new Exception("bad wav " + path);
        int samples = data.Length / 2;
        short[] pcm = new short[samples];
        Buffer.BlockCopy(data, 0, pcm, 0, data.Length);
        int thresh = 400;
        int first = 0, last = samples - 1;
        while (first < samples && Math.Abs(pcm[first]) < thresh) first++;
        while (last > first && Math.Abs(pcm[last]) < thresh) last--;
        int pad = (int)(sr * padMs / 1000.0);
        first = Math.Max(0, first - pad);
        last = Math.Min(samples - 1, last + pad);
        int n = last - first + 1;
        float m = 0;
        float[] f = new float[n];
        for (int i = 0; i < n; i++)
        {
            f[i] = pcm[first + i] / 32768f;
            float a = Math.Abs(f[i]);
            if (a > m) m = a;
        }
        float scale = m > 0 ? peak / m : 1f;
        int fade = Math.Max(1, (int)(sr * 0.008));
        short[] outPcm = new short[n];
        for (int i = 0; i < n; i++)
        {
            float v = f[i] * scale;
            if (i < fade) v *= i / (float)fade;
            if (i > n - fade) v *= (n - 1 - i) / (float)fade;
            if (v > 1f) v = 1f; if (v < -1f) v = -1f;
            outPcm[i] = (short)(v * 32767);
        }
        using (FileStream fs = File.Create(path))
        using (BinaryWriter bw = new BinaryWriter(fs))
        {
            int dataSize = n * 2;
            bw.Write(Encoding.ASCII.GetBytes("RIFF"));
            bw.Write(36 + dataSize);
            bw.Write(Encoding.ASCII.GetBytes("WAVE"));
            bw.Write(Encoding.ASCII.GetBytes("fmt "));
            bw.Write(16);
            bw.Write((short)1);
            bw.Write((short)channels);
            bw.Write(sr);
            bw.Write(sr * channels * 2);
            bw.Write((short)(channels * 2));
            bw.Write((short)16);
            bw.Write(Encoding.ASCII.GetBytes("data"));
            bw.Write(dataSize);
            byte[] bytes = new byte[dataSize];
            Buffer.BlockCopy(outPcm, 0, bytes, 0, dataSize);
            bw.Write(bytes);
        }
        Console.WriteLine("{0}: {1:0.00}s", Path.GetFileName(path), n / (double)sr);
    }
}
'@
try { Add-Type -TypeDefinition $cs } catch { if ($_.Exception.Message -notmatch 'already exists') { throw } }
[VoiceTrim]::Process((Join-Path $outDir 'voice-eat.wav'), 0.95, 20)
[VoiceTrim]::Process((Join-Path $outDir 'voice-check.wav'), 0.95, 25)
[VoiceTrim]::Process((Join-Path $outDir 'voice-mate.wav'), 0.96, 30)
Write-Host "Voice assets generated in $outDir"
