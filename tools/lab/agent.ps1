<#
.SYNOPSIS
  FRONT-V1-001 — Agent REAL no laboratório descartável do frontend (tools/lab/subir.sh).

.DESCRIPTION
  Usa o Agent empacotado do repositório do Agent (target\dist\Nekkora Agent) SEM alterá-lo: copia para
  tools\lab\saidas\<id>\agent-app, cria um armazenamento de confiança só com o certificado do laboratório (validação TLS
  normal) e aponta o Agent para a origem do laboratório. Os dados do Agent ficam em tools\lab\saidas\<id>\agent-dados.

  Ações:
    preparar   cópia, confiança e configuração (apaga a cópia anterior; os dados do Agent são mantidos)
    iniciar    abre o Agent (NEKKORA_AGENT_DATA_DIR = dados do laboratório)
    parear     lê o código nkp1 da ENTRADA PADRÃO (nunca de arquivo ou argumento), abre "Parear com a Platform" (Alt+A),
               digita o código e confirma. O código não é gravado em lugar nenhum por este script.
    executar   o que a PESSOA faz no Agent para iniciar localmente (Alt+E): escolhe a pasta do pacote, aprova o pacote
               (confirmação do Agent), escolhe o Python, a entrada e a pasta de saída e inicia (Alt+I). Cada etapa é
               conferida no log do Agent; nada é assumido.
    parar      encerra o Agent desta cópia

  O pareamento e o início de uma execução são atos da PESSOA no Agent; aqui o teclado é enviado à janela do Agent como a
  pessoa faria. Nada chama /agent/api/v1 diretamente.
#>
param(
    [Parameter(Mandatory)][string]$Id,
    [Parameter(Mandatory)][ValidateSet('preparar', 'iniciar', 'parear', 'executar', 'parar')][string]$Acao,
    [string]$AgentRepo,
    # executar: pasta do pacote (a mesma impressão da versão autorizada), Python do projeto, entrada e pasta de saída
    [string]$Pacote, [string]$Python, [string]$Entrada, [string]$Saida
)
$ErrorActionPreference = 'Stop'
if (-not $AgentRepo) { $AgentRepo = Join-Path $PSScriptRoot '..\..\..\agent-int' }
Add-Type -AssemblyName System.Windows.Forms
$lab = Join-Path $PSScriptRoot "saidas\$Id"
$app = Join-Path $lab 'agent-app'
$data = Join-Path $lab 'agent-dados'
$exe = Join-Path $app 'Nekkora Agent.exe'
if (-not (Test-Path (Join-Path $lab 'laboratorio.txt'))) { throw "laboratório $Id não encontrado ($lab)" }
$apiUrl = ((Get-Content (Join-Path $lab 'laboratorio.txt')) | Where-Object { $_ -like 'api=*' }) -replace '^api=', ''

function Agent-Processes { @(Get-CimInstance Win32_Process -Filter "Name='Nekkora Agent.exe'" | Where-Object { $_.ExecutablePath -eq $exe }) }

function Agent-Window([string]$TitlePart) {
    foreach ($p in Agent-Processes) {
        $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
        if ($proc -and $proc.MainWindowHandle -ne 0 -and (-not $TitlePart -or $proc.MainWindowTitle -like "*$TitlePart*")) { return $proc }
    }
    return $null
}

function Wait-For([scriptblock]$Cond, [int]$Seconds, [string]$What) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) { $r = & $Cond; if ($r) { return $r }; Start-Sleep -Milliseconds 400 }
    throw "tempo esgotado: $What"
}

function Ensure-Win {
    if (-not ('FrontLabWin' -as [type])) {
            Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class FrontLabWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static IntPtr Find(uint pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) { var s = new StringBuilder(512); GetWindowText(h, s, 512);
        if (s.ToString().Contains(title)) { found = h; return false; } }
      return true; }, IntPtr.Zero);
    return found;
  }
  public static bool Focus(IntPtr h) {
    for (int i = 0; i < 10; i++) {
      keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
      ShowWindow(h, 9); SetForegroundWindow(h); System.Threading.Thread.Sleep(150);
      if (GetForegroundWindow() == h) return true;
    }
    return false;
  }
}
"@
    }
}

function Log-Count([string]$Pattern) {
    $log = Join-Path $data 'logs\agent.log'
    if (-not (Test-Path $log)) { return 0 }
    $fs = [IO.File]::Open($log, 'Open', 'Read', [IO.FileShare]'ReadWrite, Delete')
    try { $text = (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd() } finally { $fs.Dispose() }
    return ([regex]::Matches($text, $Pattern)).Count
}

switch ($Acao) {
    'preparar' {
        if (Agent-Processes) { throw 'o Agent desta cópia está aberto: pare antes de preparar' }
        $dist = Join-Path (Resolve-Path $AgentRepo) 'target\dist\Nekkora Agent'
        if (-not (Test-Path (Join-Path $dist 'Nekkora Agent.exe'))) { throw "Agent empacotado não encontrado em $dist" }
        if (Test-Path $app) { Remove-Item -Recurse -Force $app }
        Copy-Item -Recurse $dist $app
        $commit = ([regex]::Match((Get-Content -Raw (Join-Path $app 'VERSOES.txt')), 'commit: ([0-9a-f]{40})')).Groups[1].Value
        $trust = Join-Path $lab 'confianca-laboratorio.p12'
        if (Test-Path $trust) { Remove-Item -Force $trust }
        & (Join-Path $env:JAVA_HOME 'bin\keytool.exe') -importcert -noprompt -alias laboratorio -file (Join-Path $lab 'certificado-laboratorio.pem') -keystore $trust -storetype PKCS12 -storepass laboratorio | Out-Null
        $cfg = Join-Path $app 'app\Nekkora Agent.cfg'
        $text = [IO.File]::ReadAllText($cfg)
        $text = $text.Replace('[JavaOptions]', "[JavaOptions]`r`njava-options=-Djavax.net.ssl.trustStore=$trust`r`njava-options=-Djavax.net.ssl.trustStoreType=PKCS12`r`njava-options=-Djavax.net.ssl.trustStorePassword=laboratorio")
        [IO.File]::WriteAllText($cfg, $text)
        New-Item -ItemType Directory -Force (Join-Path $data 'config') | Out-Null
        $json = "{`n  `"format`": `"nekkora-agent/config`",`n  `"version`": 1,`n  `"theme`": `"sakura-dark`",`n  `"shortcuts`": {`n    `"platformUrl`": `"$apiUrl`",`n    `"studioExecutable`": null`n  }`n}`n"
        [IO.File]::WriteAllText((Join-Path $data 'config\agent-config.json'), $json, (New-Object System.Text.UTF8Encoding $false))
        "agent_commit=$commit`nplatform=$apiUrl`npreparado_em=$((Get-Date).ToUniversalTime().ToString('o'))" | Set-Content -Encoding utf8 (Join-Path $lab 'agent.txt')
        Write-Host "Agent preparado (commit $commit) apontando para $apiUrl"
    }
    'iniciar' {
        if (Agent-Processes) { Write-Host 'Agent já aberto'; break }
        $env0 = @{ PATH = $env:PATH; JAVA_HOME = $env:JAVA_HOME }
        $env:NEKKORA_AGENT_DATA_DIR = $data; $env:PATH = 'C:\Windows\System32;C:\Windows'
        Remove-Item Env:JAVA_HOME -ErrorAction SilentlyContinue
        try { Start-Process -FilePath $exe | Out-Null }
        finally { $env:PATH = $env0.PATH; $env:JAVA_HOME = $env0.JAVA_HOME; Remove-Item Env:NEKKORA_AGENT_DATA_DIR }
        $w = Wait-For { Agent-Window '' } 90 'janela do Agent'
        Write-Host "Agent aberto (PID $($w.Id): $($w.MainWindowTitle))"
    }
    'parear' {
        $code = [Console]::In.ReadLine()
        if ($code -notmatch '^nkp1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$') { throw 'código de pareamento ausente ou fora do formato (entrada padrão)' }
        Ensure-Win
        $proc = Wait-For { Agent-Window '' } 30 'janela do Agent'
        $pid0 = [uint32]$proc.Id
        if (-not [FrontLabWin]::Focus($proc.MainWindowHandle)) { throw 'não foi possível trazer a janela do Agent para a frente' }
        [System.Windows.Forms.SendKeys]::SendWait('%a')
        $dlg = Wait-For { $h = [FrontLabWin]::Find($pid0, 'Parear com a Platform'); if ($h -ne [IntPtr]::Zero) { $h } } 20 'diálogo "Parear com a Platform" (Alt+A)'
        if (-not [FrontLabWin]::Focus($dlg)) { throw 'não foi possível focar o diálogo de pareamento' }
        Start-Sleep -Milliseconds 300
        [System.Windows.Forms.SendKeys]::SendWait(($code -replace '[+^%~(){}\[\]]', '{$0}'))
        $code = $null
        Start-Sleep -Milliseconds 300
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        Write-Host 'código enviado ao diálogo de pareamento do Agent'
    }
    'executar' {
        foreach ($v in 'Pacote', 'Python', 'Entrada', 'Saida') { if (-not (Get-Variable $v -ValueOnly)) { throw "executar exige -$v" } }
        Ensure-Win
        New-Item -ItemType Directory -Force $Saida | Out-Null
        $proc = Wait-For { Agent-Window '' } 30 'janela do Agent'
        $pid0 = [uint32]$proc.Id
        function Choose([IntPtr]$dlg, [string]$keys, [string]$title, [string]$path) {
            [FrontLabWin]::Focus($dlg) | Out-Null
            [System.Windows.Forms.SendKeys]::SendWait($keys)
            $ch = Wait-For { $h = [FrontLabWin]::Find($pid0, $title); if ($h -ne [IntPtr]::Zero) { $h } } 20 "seletor '$title'"
            [FrontLabWin]::Focus($ch) | Out-Null; Start-Sleep -Milliseconds 400
            [System.Windows.Forms.SendKeys]::SendWait('^a')
            [System.Windows.Forms.SendKeys]::SendWait(($path -replace '[+^%~(){}\[\]]', '{$0}'))
            Start-Sleep -Milliseconds 300
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
            Wait-For { [FrontLabWin]::Find($pid0, $title) -eq [IntPtr]::Zero } 20 "seletor '$title' fechado" | Out-Null
        }
        $insp0 = Log-Count 'EXEC_PACKAGE_INSPECTED'; $appr0 = Log-Count 'EXEC_PACKAGE_APPROVED'; $py0 = Log-Count 'EXEC_PYTHON_CHECKED'; $st0 = Log-Count 'EXEC_STARTED'
        [FrontLabWin]::Focus($proc.MainWindowHandle) | Out-Null
        [System.Windows.Forms.SendKeys]::SendWait('%e')
        $dlg = Wait-For { $h = [FrontLabWin]::Find($pid0, 'Execução local'); if ($h -ne [IntPtr]::Zero) { $h } } 20 'janela Execução local (Alt+E)'
        Start-Sleep -Milliseconds 800
        Choose $dlg '%p' 'Pasta do pacote da automação' $Pacote
        Wait-For { (Log-Count 'EXEC_PACKAGE_INSPECTED') -gt $insp0 } 30 'pacote inspecionado' | Out-Null
        if ((Log-Count 'EXEC_PACKAGE_APPROVED') -eq $appr0) {
            # o botão "Aprovar este pacote…" vem logo depois de "Pasta do pacote" na ordem de foco
            [FrontLabWin]::Focus($dlg) | Out-Null; Start-Sleep -Milliseconds 400
            [System.Windows.Forms.SendKeys]::SendWait('{TAB}'); Start-Sleep -Milliseconds 200
            [System.Windows.Forms.SendKeys]::SendWait(' ')
            $conf = Wait-For { $h = [FrontLabWin]::Find($pid0, 'Aprovar este pacote?'); if ($h -ne [IntPtr]::Zero) { $h } } 20 'confirmação "Aprovar este pacote?"'
            [FrontLabWin]::Focus($conf) | Out-Null; Start-Sleep -Milliseconds 400
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
            Start-Sleep -Seconds 2
            if ((Log-Count 'EXEC_PACKAGE_APPROVED') -eq $appr0 -and [FrontLabWin]::Find($pid0, 'Aprovar este pacote?') -ne [IntPtr]::Zero) {
                [System.Windows.Forms.SendKeys]::SendWait('{TAB}'); Start-Sleep -Milliseconds 200; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
            }
            Wait-For { (Log-Count 'EXEC_PACKAGE_APPROVED') -gt $appr0 } 20 'aprovação registrada no Agent' | Out-Null
        }
        Choose $dlg '%y' 'Python do ambiente do projeto' $Python
        Wait-For { (Log-Count 'EXEC_PYTHON_CHECKED') -gt $py0 } 60 'Python conferido' | Out-Null
        Choose $dlg '%e' 'Entrada da automação' $Entrada
        Start-Sleep -Seconds 1
        Choose $dlg '%a' 'Pasta de saída (uma subpasta por execução)' $Saida
        Start-Sleep -Seconds 1
        [FrontLabWin]::Focus($dlg) | Out-Null
        [System.Windows.Forms.SendKeys]::SendWait('%i')
        Wait-For { (Log-Count 'EXEC_STARTED') -gt $st0 } 30 'execução iniciada no Agent' | Out-Null
        Start-Sleep -Seconds 1
        [FrontLabWin]::Focus($dlg) | Out-Null
        [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
        Write-Host 'execução iniciada localmente no Agent'
    }
    'parar' {
        foreach ($p in Agent-Processes) { Stop-Process -Id $p.ProcessId -Force }
        Write-Host 'Agent encerrado'
    }
}
