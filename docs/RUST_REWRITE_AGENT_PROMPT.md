# Missione: riscrittura completa di CodexPro in Rust

Sei l'agente principale e l'architetto responsabile della migrazione **completa** di CodexPro da TypeScript/Node.js a Rust. Devi **realizzare** il porting, non limitarti a un piano o a un proof of concept. Organizza sottoagenti per workstream indipendenti, controlla personalmente le integrazioni e porta il nuovo runtime a una sostituzione verificata dell'attuale.

## Obiettivo e priorità

La priorità assoluta è **correttezza, affidabilità, manutenibilità e chiarezza del codice**, non la velocità di esecuzione o la velocità della migrazione. Rust è una scelta intenzionale per imporre maggiore disciplina agli LLM. Evita una traduzione riga per riga del TypeScript: progetta moduli profondi, API strette, tipi di dominio significativi ed errori espliciti. Non aggiungere astrazioni o crate senza un confine reale. Evita `unwrap`, `expect` e `panic!` nei percorsi di runtime, tranne casi comprovati e documentati.

## Fonti di verità e preparazione

1. Usa **esclusivamente CodexPro CAP** per accedere al repository CodexPro e lavorare sui suoi file. All'inizio leggi stato Git, `README.md`, `docs/PRODUCT_USE_CASE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `config.example.env`, le interfacce MCP in `src/server.ts`, il server HTTP, il launcher e i test. Completa un inventario verificabile delle funzionalità esistenti.
2. Prendi come modello di **disciplina** (non come codice da copiare) le regole, le skill e il refactoring playbook di `C:\Projects\ace-project\ace-blocker` e della radice Ace Project, accessibili tramite CAP. In particolare studia `AGENTS.md`, `docs/ai/REFACTORING_PLAYBOOK.md`, `BOUNDARIES_AND_ABSTRACTIONS.md`, `DOMAIN_TYPES.md`, `REVIEW_GATES.md`. Adatta i principi a CodexPro e scrivi un `AGENTS.md` specifico nel nuovo workspace Rust.
3. Usa skill pertinenti a Rust, async Tokio, testing, code review, design dei moduli e sicurezza; verificane il contenuto prima di applicarle. Se serve uno strumento non disponibile, documenta il blocco e prosegui con ciò che è possibile. Non inventare risultati di test.

## Vincoli di compatibilità non negoziabili

- **Un solo server MCP, più chat/agenti concorrenti, stesso filesystem reale**. Non dedurre l'identità di una chat dalla connessione o dalla sessione MCP; non introdurre `client_id` obbligatori. Workspace ID stabili e targeting esplicito; nessuna selezione implicita condivisa fra chat.
- Preserva il contratto MCP esistente: nomi dei tool, schemi, strutture delle risposte, modalità di sicurezza, errori di protocollo, autenticazione, trasporto HTTP streamable/SSE e stdio, riconnessione e limiti di sessione. Ogni incompatibilità richiede motivazione, test e strategia di migrazione; non eliminare silenziosamente funzionalità.
- Preserva gli strumenti per filesystem, ricerca/analisi, Git, bash/PowerShell/WSL, modifiche con `expected_sha256`, output limitati/redatti, gestione skill, handoff e contesto.
- Preserva anche le funzionalità opzionali già supportate: sottoagenti, backend browser/ChatGPT, browser automation, VM/QEMU/Hyper-V e relativi comandi, widget, launcher, profili, tunnel e Windows. Se una libreria Rust non copre un'integrazione, isola un **adapter minimo, esplicito e testato**, eventualmente temporaneo, senza ricostruire il core Rust in TypeScript.
- Mantieni le protezioni: allowed roots, blocked paths, symlink/TOCTOU, redazione credenziali e segreti, command safety, file atomici, cancellazioni controllate, permessi, limiti di risorse, shutdown ordinato. Nessun dato di produzione, credenziale, cache o sessione deve essere cancellato per facilitare il porting.
- Gestisci esplicitamente concorrenza reale: sessioni SSE lunghe, POST paralleli, capacity/TTL, race tra inizializzazioni e chiusure, CAS concorrenti, cancels/timeouts, ownership delle risorse, riavvio del servizio e cleanup. In particolare mantieni il comportamento già corretto dal test `scripts/http-multiconnection-smoke.mjs`.
- Logging pensato per esseri umani e LLM: eventi in formato leggibile con timestamp, livello, componente, ID sessione/agente, causa, durata e contesto redatto; rotazione e retention. Eventuale formato strutturato opzionale per le macchine. Un errore deve essere diagnosticabile senza leggere megabyte di JSON grezzo.

## Architettura e metodo

1. Crea prima una **matrice di parità** fra TypeScript e Rust per ogni comando, tool MCP, flusso CLI, test di sicurezza e comportamento multi-agente. Scrivi un piano di migrazione in `docs/rust-migration/`, con contratti e criteri di accettazione per ciascun workstream.
2. Definisci un Cargo workspace piccolo e coerente; separa i confini **solo dove servono** (dominio/workspace e policy, MCP/transport, Git/FS/commands, runtime e risorse opzionali, CLI/config). Dipendenze acicliche; niente mega-file, singleton globali superflui o framework fai-da-te. Preferisci librerie Rust consolidate, ma verifica API/versioni realmente disponibili.
3. Delega a sottoagenti le aree con file o crate separati. Ogni delega deve specificare confini, contratti, test e output. Evita più agenti che editano contemporaneamente gli stessi file; integra e revisiona tu i contributi. Usa worktree isolati solo dove utili e coordina le operazioni Git.
4. Procedi per **vertical slice funzionanti**: inizializzazione MCP e tool di base; workspace/security/fs; Git/shell; logging/config/launcher; agenti/browser; VM e altri tool; integrazione finale. Non dichiarare completo un modulo solo perché compila.
5. Conserva l'implementazione TypeScript come **oracle temporaneo** per test di compatibilità. Esegui gli stessi casi contro entrambi e confronta risultati/protocollo. Mantieni operativa la versione precedente finché il binario Rust non supera tutti i gate; commuta launcher e documentazione soltanto dopo le verifiche.
6. Non introdurre compatibilità legacy inutile, ma non rompere configurazioni o dati reali senza una conversione provata e reversibile. No workaround silenziosi. Ogni blocco deve comparire in una lista esplicita e verificabile.

## Quality gates obbligatori

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo check --workspace`, `cargo test --workspace`; test Windows per le componenti Windows e build reale della release.
- Test di contratti MCP e launcher, parity test su schemi/risposte e funzionalità, scenari `docs/PRODUCT_USE_CASE.md`, test di concorrenza e stress con **molte sessioni simultanee**, riconnessione, rete instabile, crash/recovery, timeouts, cancellazioni, carico e risorse.
- Test di sicurezza: traversal/symlink, segreti nei log, path non autorizzati, comandi rischiosi, conflitti CAS, accesso concurrente e permission boundaries. Nessun test può essere segnato come passato senza output effettivo.
- Review indipendente per architettura, sicurezza e conformità alla specifica a ogni modifica trasversale. Correggi le cause, non nascondere errori con `allow`, `unwrap` o test indeboliti.
- Aggiorna README, installazione, packaging, docs tecniche, istruzioni agenti e changelog. Nessun requisito vago: mantieni una checklist verificabile con file/test/evidenza.

## Git, autonomia e consegna

Lavora autonomamente fino al massimo risultato possibile con i tool a disposizione. Non fermarti dopo aver scritto il piano. Rispetta file preesistenti e modifiche non committate; non usare `reset --hard`, force-push o operazioni distruttive. Esegui **commit piccoli e coerenti per milestone verificate**, con prefissi convenzionali, senza committare segreti o file temporanei. Non fare deploy o distruggere dati senza autorizzazione.

**Definizione di completamento:** la distribuzione di CodexPro usa il runtime Rust come implementazione principale; tutti i tool e le funzioni richieste hanno parità comprovata o un'eccezione esplicita autorizzata; le suite di test e la review finale passano; launcher/packaging/documentazione sono aggiornati; esiste un percorso di rollback. Prima di allora, comunica precisamente cosa è completato e cosa manca, senza dichiarare il porting concluso.

Inizia con inventario dei contratti, stato Git e matrice di parità; poi implementa immediatamente la prima vertical slice.