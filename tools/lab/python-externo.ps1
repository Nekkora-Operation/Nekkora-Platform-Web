<#
.SYNOPSIS
  AGENT-PYTHON-001 (Marco 1) - lado da MAQUINA no laboratorio descartavel: um Python EXTERNO (sem nada da Nekkora) que o
  Agendador de Tarefas do Windows ja executa, e a unica mudanca na tarefa: passar pelo lancador do Agent.

.DESCRIPTION
  Tudo fica isolado no laboratorio: cliente em tools\lab\saidas\<id>\cliente (venv propria, script, CSV de exemplo SEM dados
  reais), dados do Agent em tools\lab\saidas\<id>\agent-dados (a copia do Agent le a pasta por -Dnekkora.agent.dataDir no
  .cfg dos executaveis de console; o Agent instalado da pessoa, se houver, nunca e tocado) e tarefa agendada com o nome
  Nekkora-<id>-relatorio (so dela).

  Acoes:
    preparar-cliente  venv do cliente + script de exemplo + tarefa agendada ORIGINAL (chama o Python direto, horario 03:00)
    rodar             dispara a tarefa agora e espera o fim; imprime o codigo que o AGENDADOR registrou (LastTaskResult)
    disparar|esperar  o mesmo em dois passos (para interromper o canal durante uma execucao longa)
    vincular          aprova o vinculo local (nekkora-console vincular; a confirmacao SIM e o ato da pessoa NA maquina -
                      no laboratorio, executado pelo operador e registrado)
    usar-lancador     troca SO o programa da tarefa: nekkora-lancar --vinculo <nome> -- <python> <script> <os mesmos argumentos>;
                      mantem venv, script, argumentos, pasta de trabalho e horario
    argumentos        troca os argumentos do cliente na tarefa (cenario de erro, execucao longa, sentinela)
    efeitos           quantas linhas o script ja gravou em efeitos.txt (efeito verificavel e contavel)
    remover           apaga a tarefa agendada do laboratorio
    instalar-pacote   (Marco 2) nekkora-console pacote instalar <zip> --python <venv do cliente> --saida <saida-pedidos>; a
                      confirmacao SIM e o ato da pessoa NA maquina (no laboratorio, executado pelo operador e registrado)
    falha-laboratorio (Marco 2) liga UMA falha injetada so de laboratorio na copia do Agent (-Extra perderConfirmacaoDecisao |
                      quedaAposStarting | nenhuma); vale na proxima abertura do Agent
    efeitos-pedidos   linhas gravadas pelo pacote externo em saida-pedidos\efeitos.txt
#>
param(
    [Parameter(Mandatory)][string]$Id,
    [Parameter(Mandatory)][ValidateSet('preparar-cliente', 'rodar', 'disparar', 'esperar', 'vincular', 'usar-lancador', 'argumentos', 'efeitos', 'remover', 'instalar-pacote', 'falha-laboratorio', 'efeitos-pedidos')][string]$Acao,
    [string]$Automacao,
    [string]$Extra = '',
    [string]$Exemplo
)
$ErrorActionPreference = 'Stop'
$lab = Join-Path $PSScriptRoot "saidas\$Id"
if (-not (Test-Path (Join-Path $lab 'laboratorio.txt'))) { throw "laboratorio $Id nao encontrado" }
$cliente = Join-Path $lab 'cliente'
$venv = Join-Path $cliente 'venv'
$python = Join-Path $venv 'Scripts\python.exe'
$script = Join-Path $cliente 'relatorio.py'
$app = Join-Path $lab 'agent-app'
$dados = Join-Path $lab 'agent-dados'
$tarefa = "Nekkora-$Id-relatorio"
$vinculo = 'relatorio-csv'
$base = '--entrada vendas.csv --saida resumo.txt --efeitos efeitos.txt'

function Quote([string]$s) { '"' + $s + '"' }

function Set-ConsoleDataDir {
    foreach ($n in 'nekkora-lancar', 'nekkora-console') {
        $cfg = Join-Path $app "app\$n.cfg"
        if (-not (Test-Path $cfg)) { throw "copia do Agent sem $n (rode agent.ps1 -Acao preparar)" }
        $t = [IO.File]::ReadAllText($cfg)
        if ($t -notmatch 'nekkora\.agent\.dataDir') {
            $t = $t.Replace('[JavaOptions]', "[JavaOptions]`r`njava-options=-Dnekkora.agent.dataDir=$dados")
            [IO.File]::WriteAllText($cfg, $t)
        }
    }
}

function Task-Wait {
    $deadline = (Get-Date).AddMinutes(10)
    Start-Sleep -Seconds 2
    while ((Get-ScheduledTask -TaskName $tarefa).State -eq 'Running') {
        if ((Get-Date) -gt $deadline) { throw 'tarefa nao terminou em 10 min' }
        Start-Sleep -Seconds 1
    }
    (Get-ScheduledTaskInfo -TaskName $tarefa).LastTaskResult
}

switch ($Acao) {
    'preparar-cliente' {
        if (-not $Exemplo) { throw 'informe -Exemplo <pasta exemplo-relatorio do Agent>' }
        New-Item -ItemType Directory -Force $cliente | Out-Null
        foreach ($f in 'efeitos.txt', 'resumo.txt') { Remove-Item -Force (Join-Path $cliente $f) -ErrorAction SilentlyContinue } # cada jornada conta do zero
        Copy-Item (Join-Path $Exemplo 'relatorio.py') $script -Force
        Copy-Item (Join-Path $Exemplo 'vendas-exemplo.csv') (Join-Path $cliente 'vendas.csv') -Force
        if (-not (Test-Path $python)) { & py -3.12 -m venv $venv; if ($LASTEXITCODE -ne 0) { throw 'venv do cliente' } }
        if (Get-ScheduledTask -TaskName $tarefa -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $tarefa -Confirm:$false }
        $action = New-ScheduledTaskAction -Execute $python -Argument "$(Quote $script) $base" -WorkingDirectory $cliente
        $trigger = New-ScheduledTaskTrigger -Daily -At '03:00'
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
        Register-ScheduledTask -TaskName $tarefa -Action $action -Trigger $trigger -Settings $settings -Description 'AGENT-PYTHON-001 laboratorio: Python externo do cliente' | Out-Null
        Write-Host "cliente pronto: tarefa $tarefa chama o Python direto (venv do cliente), pasta $cliente, 03:00"
    }
    'rodar' {
        Start-ScheduledTask -TaskName $tarefa
        $r = Task-Wait
        Write-Host "codigo_registrado_pelo_agendador=$r"
    }
    'disparar' {
        Start-ScheduledTask -TaskName $tarefa
        Write-Host 'tarefa disparada (sem esperar)'
    }
    'esperar' {
        $r = Task-Wait
        Write-Host "codigo_registrado_pelo_agendador=$r"
    }
    'vincular' {
        if (-not $Automacao) { throw 'informe -Automacao <uuid>' }
        Set-ConsoleDataDir
        $exe = Join-Path $app 'nekkora-console.exe'
        $out = 'SIM' | & $exe vincular --nome $vinculo --automacao $Automacao --python $python --script $script --pasta $cliente
        if ($LASTEXITCODE -ne 0) { throw "vincular falhou ($LASTEXITCODE)" }
        $out | ForEach-Object { Write-Host $_ }
    }
    'usar-lancador' {
        Set-ConsoleDataDir
        $t = Get-ScheduledTask -TaskName $tarefa
        $old = $t.Actions[0]
        # so o programa muda: o Python, o script e os argumentos do cliente passam a ser argumentos do lancador
        $action = New-ScheduledTaskAction -Execute (Join-Path $app 'nekkora-lancar.exe') `
            -Argument "--vinculo $vinculo -- $(Quote $old.Execute) $($old.Arguments)" -WorkingDirectory $old.WorkingDirectory
        Set-ScheduledTask -TaskName $tarefa -Action $action | Out-Null
        $n = (Get-ScheduledTask -TaskName $tarefa).Actions[0]
        Write-Host "tarefa: programa=$($n.Execute) | pasta=$($n.WorkingDirectory) | horario=$((Get-ScheduledTask -TaskName $tarefa).Triggers[0].StartBoundary)"
    }
    'argumentos' {
        $t = Get-ScheduledTask -TaskName $tarefa
        $old = $t.Actions[0]
        $prefix = if ($old.Execute -like '*nekkora-lancar.exe') { "--vinculo $vinculo -- $(Quote $python) $(Quote $script)" } else { Quote $script }
        $action = New-ScheduledTaskAction -Execute $old.Execute -Argument "$prefix $base $Extra".Trim() -WorkingDirectory $old.WorkingDirectory
        Set-ScheduledTask -TaskName $tarefa -Action $action | Out-Null
        Write-Host 'argumentos do cliente trocados (valor nao impresso)'
    }
    'efeitos' {
        $f = Join-Path $cliente 'efeitos.txt'
        $n = if (Test-Path $f) { @(Get-Content $f).Count } else { 0 }
        Write-Host "efeitos=$n"
    }
    'instalar-pacote' {
        if (-not $Exemplo) { throw 'informe -Exemplo <zip do pacote externo>' }
        Set-ConsoleDataDir
        $saida = Join-Path $lab 'saida-pedidos'
        New-Item -ItemType Directory -Force $saida | Out-Null
        $exe = Join-Path $app 'nekkora-console.exe'
        $out = 'SIM' | & $exe pacote instalar $Exemplo --python $python --saida $saida
        if ($LASTEXITCODE -ne 0) { throw "pacote instalar falhou ($LASTEXITCODE): $out" }
        $out | ForEach-Object { Write-Host $_ }
    }
    'falha-laboratorio' {
        $cfg = Join-Path $app 'app\Nekkora Agent.cfg'
        $t = [IO.File]::ReadAllText($cfg)
        $t = ($t -split "`r`n" | Where-Object { $_ -notmatch 'nekkora\.agent\.lab\.' }) -join "`r`n"
        if ($Extra -and $Extra -ne 'nenhuma') {
            if ($Extra -notin 'perderConfirmacaoDecisao', 'quedaAposStarting') { throw "falha desconhecida: $Extra" }
            $t = $t.Replace('[JavaOptions]', "[JavaOptions]`r`njava-options=-Dnekkora.agent.lab.$Extra=true")
        }
        [IO.File]::WriteAllText($cfg, $t)
        Write-Host "falha de laboratorio na copia do Agent: $(if ($Extra) { $Extra } else { 'nenhuma' })"
    }
    'efeitos-pedidos' {
        $f = Join-Path $lab 'saida-pedidos\efeitos.txt'
        $n = if (Test-Path $f) { @(Get-Content $f).Count } else { 0 }
        Write-Host "efeitos=$n"
    }
    'remover' {
        if (Get-ScheduledTask -TaskName $tarefa -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $tarefa -Confirm:$false }
        Write-Host "tarefa $tarefa removida"
    }
}
