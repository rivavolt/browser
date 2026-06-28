//! `browser` — query and control browser tabs from the command line.
//!
//! The command shape is `browser <group> <verb> [args]`, e.g.
//! `browser tabs list`, `browser tabs content <id>`, `browser windows list`.
//!
//! Each invocation connects to a browser-ext native-messaging host over a
//! Unix socket, sends one JSON request, and prints the JSON reply. Output is
//! JSON by default; `--plain` switches to a line-oriented form for shells.

use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::exit;

const USAGE: &str = "\
browser — query and control browser tabs

usage:
  browser [--plain] [--browser chrome|firefox] <group> <verb> [args]

groups & verbs:
  tabs list                 list all tabs
  tabs content <id>         readable text of a tab
  tabs open [url]           open a new tab, optionally at a url
  tabs navigate <id> <url>  navigate a tab to a url
  tabs activate <id>        focus a tab and its window
  tabs eval <id> <js>       run JS in a tab as a string via CDP Runtime.evaluate
                            (blocked on Trusted-Types pages; use `tabs js` there)
  tabs query <id> (--selector <css> | --text <sub>) [--all]
                            inspect the DOM via chrome.debugger (works on
                            Trusted-Types pages, no eval): matching elements'
                            tag/text/attributes/center-coords
  tabs js <id> <code> [--main]
                            run code as a function body via scripting.executeScript,
                            print the result as JSON. Works on Trusted-Types pages
                            (takeout/accounts.google.com) where `tabs eval` cannot,
                            so it's how you inspect their DOM. Isolated world by
                            default; --main for page globals. Code may `return` or
                            be a bare expression.
  tabs click <id> (--selector <css> [--nth <n>] | --text <sub> [--nth <n>] | --at <x,y>)
                            click an element with a real mouse via chrome.debugger
                            (CDP input events), so it works on Trusted-Types pages
                            that refuse tabs eval. --nth picks among repeated
                            matches (0-based); --at clicks viewport coords.
  tabs move <id> --index <n> [--window <id>]
                            reorder a tab, or move it to another window
  tabs screenshot <id> [--out <path>] [--clip X,Y,W,H | --selector <css> | --full-page]
                            capture a tab PNG: visible viewport by default, or a
                            native region / element / full-page clip (those three
                            use chrome.debugger)
  tabs wait <id> [--timeout <secs>]
                            wait until a tab finishes loading (default 30s)
  tabs close <id>...        close one or more tabs by id
  windows list              list all windows

options:
  --plain                   line-oriented output instead of JSON
  --browser <name>          target browser (default: chrome)
  -h, --help                show this help";

fn runtime_dir() -> PathBuf {
    match env::var("XDG_RUNTIME_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => env::temp_dir(),
    }
}

fn socket_path(browser: &str) -> PathBuf {
    runtime_dir().join(format!("browser-ext-{browser}.sock"))
}

fn die(msg: impl AsRef<str>) -> ! {
    eprintln!("browser: {}", msg.as_ref());
    exit(1);
}

/// Send one request to the native host and return the parsed reply.
fn request(browser: &str, method: &str, params: Value) -> Value {
    let sock = socket_path(browser);
    let mut stream = UnixStream::connect(&sock).unwrap_or_else(|e| {
        die(format!(
            "cannot reach {browser} host at {} ({e}); is the browser running with the extension installed?",
            sock.display()
        ))
    });

    let req = json!({ "method": method, "params": params });
    let mut line = req.to_string();
    line.push('\n');
    stream
        .write_all(line.as_bytes())
        .unwrap_or_else(|e| die(format!("write failed: {e}")));

    let mut resp = String::new();
    BufReader::new(stream)
        .read_line(&mut resp)
        .unwrap_or_else(|e| die(format!("read failed: {e}")));

    let reply: Value = serde_json::from_str(resp.trim())
        .unwrap_or_else(|e| die(format!("bad reply from host: {e}")));

    if let Some(err) = reply.get("error").and_then(Value::as_str) {
        die(err);
    }
    reply.get("result").cloned().unwrap_or(Value::Null)
}

fn print_json(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap());
}

/// Decode standard base64 (with optional `=` padding) into raw bytes.
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for &c in s.as_bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        let v = val(c).ok_or_else(|| format!("invalid base64 byte: {c}"))?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

/// Pull the raw bytes out of a `data:...;base64,<payload>` URL.
fn data_url_bytes(data_url: &str) -> Result<Vec<u8>, String> {
    let payload = data_url
        .split_once(";base64,")
        .map(|(_, p)| p)
        .ok_or("host returned a non-base64 data URL")?;
    base64_decode(payload)
}

fn main() {
    let mut plain = false;
    let mut browser = "chrome".to_string();
    let mut rest: Vec<String> = Vec::new();

    // Parse flags; everything after them is the group/verb/args.
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--plain" => plain = true,
            "--browser" => {
                browser = args
                    .next()
                    .unwrap_or_else(|| die("--browser needs a value"));
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                return;
            }
            _ => {
                rest.push(arg);
                rest.extend(args.by_ref());
                break;
            }
        }
    }

    if rest.is_empty() {
        eprintln!("{USAGE}");
        exit(2);
    }

    let group = rest[0].as_str();
    let verb = rest.get(1).map(String::as_str).unwrap_or("");
    let args = &rest[2.min(rest.len())..];

    match (group, verb) {
        ("tabs", "list") => {
            let result = request(&browser, "tabs.list", json!({}));
            if plain {
                for t in result.as_array().map(Vec::as_slice).unwrap_or(&[]) {
                    println!(
                        "{}\t{}\t{}",
                        t["id"], t["title"].as_str().unwrap_or(""), t["url"].as_str().unwrap_or("")
                    );
                }
            } else {
                print_json(&result);
            }
        }

        ("tabs", "content") => {
            let id = args
                .first()
                .unwrap_or_else(|| die("tabs content needs a tab id"));
            let tab_id: i64 = id
                .parse()
                .unwrap_or_else(|_| die(format!("invalid tab id: {id}")));
            let result = request(&browser, "tabs.content", json!({ "id": tab_id }));
            if plain {
                println!("{}", result["text"].as_str().unwrap_or(""));
            } else {
                print_json(&result);
            }
        }

        ("tabs", "open") => {
            let url = args.first().map(String::as_str);
            let result = request(&browser, "tabs.open", json!({ "url": url }));
            if plain {
                println!("{}", result["id"]);
            } else {
                print_json(&result);
            }
        }

        ("tabs", "navigate") => {
            let id = args
                .first()
                .unwrap_or_else(|| die("tabs navigate needs a tab id and a url"));
            let tab_id: i64 = id
                .parse()
                .unwrap_or_else(|_| die(format!("invalid tab id: {id}")));
            let url = args
                .get(1)
                .unwrap_or_else(|| die("tabs navigate needs a url"));
            let result =
                request(&browser, "tabs.navigate", json!({ "id": tab_id, "url": url }));
            if plain {
                println!("{}", result["id"]);
            } else {
                print_json(&result);
            }
        }

        ("tabs", "activate") => {
            let id = args
                .first()
                .unwrap_or_else(|| die("tabs activate needs a tab id"));
            let tab_id: i64 = id
                .parse()
                .unwrap_or_else(|_| die(format!("invalid tab id: {id}")));
            let result = request(&browser, "tabs.activate", json!({ "id": tab_id }));
            if plain {
                println!("{}", result["id"]);
            } else {
                print_json(&result);
            }
        }

        ("tabs", "eval") => {
            let id = args
                .first()
                .unwrap_or_else(|| die("tabs eval needs a tab id and JS to run"));
            let tab_id: i64 = id
                .parse()
                .unwrap_or_else(|_| die(format!("invalid tab id: {id}")));
            let code = args
                .get(1)
                .unwrap_or_else(|| die("tabs eval needs JS to run"));
            let result =
                request(&browser, "tabs.eval", json!({ "id": tab_id, "code": code }));
            if plain {
                match &result["result"] {
                    Value::String(s) => println!("{s}"),
                    other => println!("{other}"),
                }
            } else {
                print_json(&result);
            }
        }

        ("tabs", "js") => {
            let id = args
                .first()
                .unwrap_or_else(|| die("tabs js needs a tab id and code to run"));
            let tab_id: i64 = id
                .parse()
                .unwrap_or_else(|_| die(format!("invalid tab id: {id}")));
            let mut code: Option<String> = None;
            let mut world = "ISOLATED";
            for a in &args[1..] {
                match a.as_str() {
                    "--main" => world = "MAIN",
                    s if code.is_none() => code = Some(s.to_string()),
                    other => die(format!("unknown option for tabs js: {other}")),
                }
            }
            let code = code.unwrap_or_else(|| die("tabs js needs code to run"));
            let result = request(
                &browser,
                "tabs.js",
                json!({ "id": tab_id, "code": code, "world": world }),
            );
            if plain {
                match &result["result"] {
                    Value::String(s) => println!("{s}"),
                    other => println!("{other}"),
                }
            } else {
                print_json(&result);
            }
        }

        ("tabs", "click") => {
            let id = args.first().unwrap_or_else(|| {
                die("tabs click needs a tab id and --selector, --text, or --at")
            });
            let tab_id: i64 = id
                .parse()
                .unwrap_or_else(|_| die(format!("invalid tab id: {id}")));
            let mut selector: Option<String> = None;
            let mut text: Option<String> = None;
            let mut nth: Option<i64> = None;
            let mut at: Option<(f64, f64)> = None;
            let mut it = args[1..].iter();
            while let Some(flag) = it.next() {
                match flag.as_str() {
                    "--selector" => {
                        selector = Some(
                            it.next()
                                .unwrap_or_else(|| die("--selector needs a value"))
                                .clone(),
                        );
                    }
                    "--text" => {
                        text = Some(
                            it.next()
                                .unwrap_or_else(|| die("--text needs a value"))
                                .clone(),
                        );
                    }
                    "--nth" => {
                        let v = it.next().unwrap_or_else(|| die("--nth needs a value"));
                        nth = Some(
                            v.parse()
                                .unwrap_or_else(|_| die(format!("invalid --nth: {v}"))),
                        );
                    }
                    "--at" => {
                        let v = it.next().unwrap_or_else(|| die("--at needs X,Y"));
                        let n: Vec<f64> = v
                            .split(',')
                            .map(|s| {
                                s.trim()
                                    .parse()
                                    .unwrap_or_else(|_| die(format!("invalid --at value: {v}")))
                            })
                            .collect();
                        if n.len() != 2 {
                            die("--at needs two comma-separated numbers: X,Y");
                        }
                        at = Some((n[0], n[1]));
                    }
                    other => die(format!("unknown option for tabs click: {other}")),
                }
            }
            if selector.is_none() && text.is_none() && at.is_none() {
                die("tabs click needs --selector, --text, or --at");
            }
            let mut p = json!({ "id": tab_id });
            if let Some(s) = selector {
                p["selector"] = json!(s);
            }
            if let Some(t) = text {
                p["text"] = json!(t);
            }
            if let Some(n) = nth {
                p["nth"] = json!(n);
            }
            if let Some((x, y)) = at {
                p["x"] = json!(x);
                p["y"] = json!(y);
            }
            let result = request(&browser, "tabs.click", p);
            if plain {
                println!(
                    "{}\t{}",
                    result["tag"].as_str().unwrap_or(""),
                    result["text"].as_str().unwrap_or("")
                );
            } else {
                print_json(&result);
            }
        }

        ("tabs", "query") => {
            let id = args
                .first()
                .unwrap_or_else(|| die("tabs query needs a tab id and --selector or --text"));
            let tab_id: i64 = id
                .parse()
                .unwrap_or_else(|_| die(format!("invalid tab id: {id}")));
            let mut selector: Option<String> = None;
            let mut text: Option<String> = None;
            let mut all = false;
            let mut it = args[1..].iter();
            while let Some(flag) = it.next() {
                match flag.as_str() {
                    "--selector" => {
                        selector = Some(
                            it.next()
                                .unwrap_or_else(|| die("--selector needs a value"))
                                .clone(),
                        );
                    }
                    "--text" => {
                        text = Some(
                            it.next()
                                .unwrap_or_else(|| die("--text needs a value"))
                                .clone(),
                        );
                    }
                    "--all" => all = true,
                    other => die(format!("unknown option for tabs query: {other}")),
                }
            }
            if selector.is_none() && text.is_none() {
                die("tabs query needs --selector or --text");
            }
            let mut p = json!({ "id": tab_id });
            if let Some(s) = selector {
                p["selector"] = json!(s);
            }
            if let Some(t) = text {
                p["text"] = json!(t);
            }
            if all {
                p["all"] = json!(true);
            }
            let result = request(&browser, "tabs.query", p);
            if plain {
                for el in result["elements"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
                    println!(
                        "{}\t{}\t{}\t{}",
                        el["tag"].as_str().unwrap_or(""),
                        el["x"],
                        el["y"],
                        el["text"].as_str().unwrap_or("")
                    );
                }
            } else {
                print_json(&result);
            }
        }

        ("tabs", "move") => {
            let id = args
                .first()
                .unwrap_or_else(|| die("tabs move needs a tab id and --index"));
            let tab_id: i64 = id
                .parse()
                .unwrap_or_else(|_| die(format!("invalid tab id: {id}")));
            let mut index: Option<i64> = None;
            let mut window: Option<i64> = None;
            let mut it = args[1..].iter();
            while let Some(flag) = it.next() {
                match flag.as_str() {
                    "--index" => {
                        let v = it.next().unwrap_or_else(|| die("--index needs a value"));
                        index = Some(
                            v.parse()
                                .unwrap_or_else(|_| die(format!("invalid index: {v}"))),
                        );
                    }
                    "--window" => {
                        let v = it.next().unwrap_or_else(|| die("--window needs a value"));
                        window = Some(
                            v.parse()
                                .unwrap_or_else(|_| die(format!("invalid window id: {v}"))),
                        );
                    }
                    other => die(format!("unknown option for tabs move: {other}")),
                }
            }
            let index = index.unwrap_or_else(|| die("tabs move needs --index"));
            let result = request(
                &browser,
                "tabs.move",
                json!({ "id": tab_id, "index": index, "windowId": window }),
            );
            if plain {
                println!("{}\t{}", result["windowId"], result["index"]);
            } else {
                print_json(&result);
            }
        }

        ("tabs", "screenshot") => {
            // Plain is the visible viewport; --clip X,Y,W,H, --selector <css>, and --full-page are native CDP captures the host performs through chrome.debugger (no post-processing crop, no focus steal).
            let id = args
                .first()
                .unwrap_or_else(|| die("tabs screenshot needs a tab id"));
            let tab_id: i64 = id
                .parse()
                .unwrap_or_else(|_| die(format!("invalid tab id: {id}")));
            let mut out: Option<String> = None;
            let mut clip: Option<Value> = None;
            let mut selector: Option<String> = None;
            let mut full_page = false;
            let mut it = args[1..].iter();
            while let Some(flag) = it.next() {
                match flag.as_str() {
                    "--out" => {
                        out = Some(
                            it.next()
                                .unwrap_or_else(|| die("--out needs a value"))
                                .clone(),
                        );
                    }
                    "--selector" => {
                        selector = Some(
                            it.next()
                                .unwrap_or_else(|| die("--selector needs a value"))
                                .clone(),
                        );
                    }
                    "--full-page" => full_page = true,
                    "--clip" => {
                        let v = it.next().unwrap_or_else(|| die("--clip needs X,Y,W,H"));
                        let n: Vec<f64> = v
                            .split(',')
                            .map(|s| {
                                s.trim()
                                    .parse()
                                    .unwrap_or_else(|_| die(format!("invalid --clip value: {v}")))
                            })
                            .collect();
                        if n.len() != 4 {
                            die("--clip needs four comma-separated numbers: X,Y,W,H");
                        }
                        clip = Some(json!({ "x": n[0], "y": n[1], "width": n[2], "height": n[3] }));
                    }
                    other => die(format!("unknown option for tabs screenshot: {other}")),
                }
            }
            let mut p = json!({ "id": tab_id });
            if let Some(c) = clip {
                p["clip"] = c;
            }
            if let Some(s) = selector {
                p["selector"] = json!(s);
            }
            if full_page {
                p["fullPage"] = json!(true);
            }
            let result = request(&browser, "tabs.screenshot", p);
            let data_url = result["dataUrl"]
                .as_str()
                .unwrap_or_else(|| die("host returned no screenshot data"));
            let png = data_url_bytes(data_url).unwrap_or_else(|e| die(e));
            match out {
                Some(path) => {
                    fs::write(&path, &png)
                        .unwrap_or_else(|e| die(format!("cannot write {path}: {e}")));
                    if !plain {
                        print_json(&json!({ "path": path, "bytes": png.len() }));
                    }
                }
                None => {
                    std::io::stdout()
                        .write_all(&png)
                        .unwrap_or_else(|e| die(format!("write failed: {e}")));
                }
            }
        }

        ("tabs", "wait") => {
            let id = args
                .first()
                .unwrap_or_else(|| die("tabs wait needs a tab id"));
            let tab_id: i64 = id
                .parse()
                .unwrap_or_else(|_| die(format!("invalid tab id: {id}")));
            let mut timeout: Option<f64> = None;
            let mut it = args[1..].iter();
            while let Some(flag) = it.next() {
                match flag.as_str() {
                    "--timeout" => {
                        let v = it.next().unwrap_or_else(|| die("--timeout needs seconds"));
                        timeout = Some(
                            v.parse()
                                .unwrap_or_else(|_| die(format!("invalid --timeout: {v}"))),
                        );
                    }
                    other => die(format!("unknown option for tabs wait: {other}")),
                }
            }
            let mut p = json!({ "id": tab_id });
            if let Some(t) = timeout {
                p["timeout"] = json!(t);
            }
            let result = request(&browser, "tabs.wait", p);
            if plain {
                println!("{}", result["status"].as_str().unwrap_or(""));
            } else {
                print_json(&result);
            }
        }

        ("tabs", "close") => {
            if args.is_empty() {
                die("tabs close needs at least one tab id");
            }
            let ids: Vec<i64> = args
                .iter()
                .map(|id| {
                    id.parse()
                        .unwrap_or_else(|_| die(format!("invalid tab id: {id}")))
                })
                .collect();
            let result = request(&browser, "tabs.close", json!({ "ids": ids }));
            if plain {
                for id in result["closed"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
                    println!("{id}");
                }
            } else {
                print_json(&result);
            }
        }

        ("windows", "list") => {
            let result = request(&browser, "windows.list", json!({}));
            if plain {
                for w in result.as_array().map(Vec::as_slice).unwrap_or(&[]) {
                    println!(
                        "{}\tfocused={}\ttabs={}",
                        w["id"], w["focused"], w["tabCount"]
                    );
                }
            } else {
                print_json(&result);
            }
        }

        ("tabs", "") | ("windows", "") => die(format!("'{group}' needs a verb; see --help")),
        (g, v) => die(format!("unknown command: {g} {v}; see --help")),
    }
}
