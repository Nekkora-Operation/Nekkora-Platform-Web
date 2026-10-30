<#
.SYNOPSIS
  FRONT-V1-001/002 — Agent REAL no laboratório descartável do frontend (tools/lab/subir.sh).

.DESCRIPTION
  Usa o Agent empacotado de um checkout ISOLADO do Agent (padrão: ..\front-v1-002-agent, construído do commit aprovado;
  ver docs/FRONT-V1-RELATORIO.md) SEM alterá-lo: copia target\dist\Nekkora Agent para
  tools\lab\saidas\<id>\agent-app, cria um armazenamento de confiança só com o certificado do laboratório (validação TLS
  normal) e aponta o Agent para a origem do laboratório. Os dados do Agent ficam em tools\lab\saidas\<id>\agent-dados.

  Ações:
    preparar   cópia, confiança e configuração (apaga a cópia anterior; os dados do Agent são mantidos)
    iniciar    abre o Agent (NEKKORA_AGENT_DATA_DIR = dados do laboratório)
    parear     lê o código nkp1 da ENTRADA PADRÃO (nunca de arquivo ou argumento), abre "Parear com a Platform" (Alt+A),
               digita o código e confirma. O código não é gravado em lugar nenhum por este script.
    abrir-execucao   prepara (Alt+E) e escolhe a pasta do pacote; espera a inspeção no log e PARA. Ponto de intervenção 1:
                     a PESSOA aprova o pacote no Agent ("Aprovar este pacote…" e a confirmação).
    completar-execucao  só depois de EXEC_PACKAGE_APPROVED registrado pelo Agent (a aprovação da pessoa): escolhe o Python,
                     a entrada e a pasta de saída e PARA. Ponto de intervenção 2: a PESSOA clica em "Iniciar".
    derrubar   reprodução segura do desfecho desconhecido (como a C6 do AGENT-PLATFORM-002): encerra à força ESTA cópia do
               Agent e, com ele fora, o processo Python da execução em curso (identificado pela pasta de saída do
               laboratório). Reaberto, o Agent reconcilia; nada é relançado.
    avisar     mostra à pessoa o que fazer agora (caixa de mensagem em processo separado)
    parar      encerra o Agent desta cópia

  FRONT-V1-002: aprovar o pacote e iniciar a execução são atos LOCAIS da pessoa. Este script não os simula (nenhuma
  tecla ou clique nesses atos, nada de cliques por cor, cópia de registros de aprovação ou alteração de estado): só
  prepara até o ponto de intervenção e confere no log do Agent que o ato aconteceu. O que ele digita por teclado é só o
  preparo: o código no diálogo de pareamento e os caminhos nos seletores de arquivo (pacote, Python, entrada, saída),
  sempre com o foco conferido na janela certa antes de cada tecla — se o foco não estiver nela, o script para em vez de
  digitar. Nada chama /agent/api/v1 diretamente.
#>
param(
    [Parameter(Mandatory)][string]$Id,
    [Parameter(Mandatory)][ValidateSet('preparar', 'iniciar', 'parear', 'abrir-execucao', 'completar-execucao', 'derrubar', 'avisar', 'parar')][string]$Acao,
    [string]$AgentRepo,
    # abrir-execucao: pasta do pacote (a mesma impressão da versão autorizada); completar-execucao: Python, entrada e saída
    [string]$Pacote, [string]$Python, [string]$Entrada, [string]$Saida,
    # avisar: texto mostrado à pessoa numa caixa de mensagem (só informa; não age no Agent)
    [string]$Aviso
)
$ErrorActionPreference = 'Stop'
if (-not $AgentRepo) { $AgentRepo = Join-Path $PSScriptRoot '..\..\..\front-v1-002-agent' }
Add-Type -AssemblyName System.Windows.Forms
$lab = Join-Path $PSScriptRoot "saidas\$Id"
$app = Join-Path $lab 'agent-app'
# pasta de dados do Agent: FRONT_LAB_AGENT_DADOS (nome dentro da saída do laboratório) ou agent-dados
$data = Join-Path $lab $(if ($env:FRONT_LAB_AGENT_DADOS) { $env:FRONT_LAB_AGENT_DADOS } else { 'agent-dados' })
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
  public static bool IsForeground(IntPtr h) { return GetForegroundWindow() == h; }
}
"@
    }
}

# Teclas só com o foco conferido: se outra janela (um aviso, a confirmação de aprovação, a pessoa) estiver na frente, o
# script para — nunca digita às cegas onde um ENTER poderia acionar um ato da pessoa.
function Send-To([IntPtr]$h, [string]$keys, [string]$what) {
    if (-not [FrontLabWin]::IsForeground($h)) { throw "foco fora de '$what': nada foi digitado" }
    [System.Windows.Forms.SendKeys]::SendWait($keys)
}

function Choose([uint32]$pid0, [IntPtr]$dlg, [string]$keys, [string]$title, [string]$path) {
    if (-not [FrontLabWin]::Focus($dlg)) { throw 'não foi possível focar a janela Execução local' }
    Send-To $dlg $keys 'Execução local'
    $ch = Wait-For { $h = [FrontLabWin]::Find($pid0, $title); if ($h -ne [IntPtr]::Zero) { $h } } 20 "seletor '$title'"
    if (-not [FrontLabWin]::Focus($ch)) { throw "não foi possível focar o seletor '$title'" }
    Start-Sleep -Milliseconds 400
    Send-To $ch '^a' $title
    Send-To $ch ($path -replace '[+^%~(){}\[\]]', '{$0}') $title
    Start-Sleep -Milliseconds 300
    Send-To $ch '{ENTER}' $title
    Wait-For { [FrontLabWin]::Find($pid0, $title) -eq [IntPtr]::Zero } 20 "seletor '$title' fechado" | Out-Null
}

# Aviso visível para a pessoa (caixa de mensagem em processo separado: não espera, não clica nada no Agent)
function Avisar([string]$Texto) {
    $t = $Texto -replace "'", "''"
    $cmd = "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('$t', 'Laboratório FRONT-V1-002 — sua vez no Agent', 'OK', 'Information', 'Button1', 'DefaultDesktopOnly')"
    Start-Process powershell -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $cmd | Out-Null
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
        Send-To $proc.MainWindowHandle '%a' 'janela do Agent'
        $dlg = Wait-For { $h = [FrontLabWin]::Find($pid0, 'Parear com a Platform'); if ($h -ne [IntPtr]::Zero) { $h } } 20 'diálogo "Parear com a Platform" (Alt+A)'
        if (-not [FrontLabWin]::Focus($dlg)) { throw 'não foi possível focar o diálogo de pareamento' }
        Start-Sleep -Milliseconds 300
        Send-To $dlg ($code -replace '[+^%~(){}\[\]]', '{$0}') 'Parear com a Platform'
        $code = $null
        Start-Sleep -Milliseconds 300
        Send-To $dlg '{ENTER}' 'Parear com a Platform'
        Write-Host 'código enviado ao diálogo de pareamento do Agent'
    }
    'abrir-execucao' {
        if (-not $Pacote) { throw 'abrir-execucao exige -Pacote' }
        Ensure-Win
        $proc = Wait-For { Agent-Window '' } 30 'janela do Agent'
        $pid0 = [uint32]$proc.Id
        $insp0 = Log-Count 'EXEC_PACKAGE_INSPECTED'
        # a janela pode continuar aberta desde a execução anterior: nela, Alt+E é "Entrada", não "abrir"
        $dlg = [FrontLabWin]::Find($pid0, 'Execução local')
        if ($dlg -eq [IntPtr]::Zero) {
            if (-not [FrontLabWin]::Focus($proc.MainWindowHandle)) { throw 'não foi possível trazer a janela do Agent para a frente' }
            Send-To $proc.MainWindowHandle '%e' 'janela do Agent'
            $dlg = Wait-For { $h = [FrontLabWin]::Find($pid0, 'Execução local'); if ($h -ne [IntPtr]::Zero) { $h } } 20 'janela Execução local (Alt+E)'
        }
        Start-Sleep -Milliseconds 800
        Choose $pid0 $dlg '%p' 'Pasta do pacote da automação' $Pacote
        Wait-For { (Log-Count 'EXEC_PACKAGE_INSPECTED') -gt $insp0 } 30 'pacote inspecionado' | Out-Null
        Write-Host 'PONTO DE INTERVENÇÃO 1: no Agent, a pessoa aprova o pacote ("Aprovar este pacote…" e a confirmação).'
    }
    'completar-execucao' {
        foreach ($v in 'Python', 'Entrada', 'Saida') { if (-not (Get-Variable $v -ValueOnly)) { throw "completar-execucao exige -$v" } }
        Ensure-Win
        New-Item -ItemType Directory -Force $Saida | Out-Null
        $proc = Wait-For { Agent-Window '' } 30 'janela do Agent'
        $pid0 = [uint32]$proc.Id
        $dlg = [FrontLabWin]::Find($pid0, 'Execução local')
        if ($dlg -eq [IntPtr]::Zero) { throw 'janela "Execução local" não está aberta' }
        if ([FrontLabWin]::Find($pid0, 'Aprovar este pacote?') -ne [IntPtr]::Zero) { throw 'a confirmação de aprovação ainda está aberta: a pessoa decide antes' }
        $py0 = Log-Count 'EXEC_PYTHON_CHECKED'
        Choose $pid0 $dlg '%y' 'Python do ambiente do projeto' $Python
        Wait-For { (Log-Count 'EXEC_PYTHON_CHECKED') -gt $py0 } 60 'Python conferido' | Out-Null
        Choose $pid0 $dlg '%e' 'Entrada da automação' $Entrada
        Start-Sleep -Seconds 1
        Choose $pid0 $dlg '%a' 'Pasta de saída (uma subpasta por execução)' $Saida
        Write-Host 'PONTO DE INTERVENÇÃO 2: no Agent, a pessoa clica em "Iniciar".'
    }
    'derrubar' {
        if (-not $Saida) { throw 'derrubar exige -Saida (pasta de saída do laboratório que identifica a execução)' }
        $agents = Agent-Processes
        if (-not $agents) { throw 'o Agent desta cópia não está aberto' }
        foreach ($p in $agents) { Stop-Process -Id $p.ProcessId -Force }
        Wait-For { -not (Agent-Processes) } 20 'Agent encerrado' | Out-Null
        $full = (Resolve-Path $Saida).Path
        $runs = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($full) })
        foreach ($r in $runs) { Stop-Process -Id $r.ProcessId -Force -ErrorAction SilentlyContinue }
        Write-Host "Agent encerrado à força; processos da execução encerrados com o Agent fora: $($runs.Count)"
    }
    'avisar' {
        if (-not $Aviso) { throw 'avisar exige -Aviso' }
        Avisar $Aviso
        Write-Host "aviso mostrado: $Aviso"
    }
    'parar' {
        foreach ($p in Agent-Processes) { Stop-Process -Id $p.ProcessId -Force }
        Write-Host 'Agent encerrado'
    }
}
