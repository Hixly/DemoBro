"use client";

import Image from "next/image";
import { FormEvent, useState } from "react";
import styles from "./BetaGate.module.css";

type SubmitState = "idle" | "loading" | "error" | "success";

export function BetaGate() {
  const [accessKey, setAccessKey] = useState("");
  const [state, setState] = useState<SubmitState>("idle");
  const [message, setMessage] = useState(
    "Invited tester? Your key was included with your invitation.",
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessKey.trim()) {
      setState("error");
      setMessage("Enter today’s access key to continue.");
      return;
    }

    setState("loading");
    setMessage("Checking the guest list…");

    try {
      const response = await fetch("/api/beta-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setState("error");
        setMessage(result.error ?? "That key didn’t work. Try it again.");
        return;
      }

      setState("success");
      setMessage("You’re on the list. Rolling camera…");
      window.setTimeout(() => window.location.assign("/"), 420);
    } catch {
      setState("error");
      setMessage("We couldn’t check the key. Give it another try.");
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.stage} aria-labelledby="beta-title">
        <div className={styles.logoHalf} aria-label="DemoBro">
          <div className={styles.registrationRig}>
            <span className={styles.cornerA} aria-hidden="true" />
            <span className={styles.cornerB} aria-hidden="true" />
            <div className={styles.reelBadge}>
              <Image
                src="/brand/demobro-logo.png"
                alt=""
                width={92}
                height={92}
                priority
                aria-hidden="true"
              />
            </div>
            <div className={styles.wordmark} aria-label="DemoBro">
              <span className={styles.ghostInk} aria-hidden="true">DemoBro</span>
              <span className={styles.ghostBlue} aria-hidden="true">DemoBro</span>
              <span className={styles.liveWord}>Demo<span>Bro</span></span>
            </div>
            <div className={styles.registrationLine} aria-hidden="true" />
          </div>
          <p className={styles.productionNote}>Private screening · invited testers only</p>
        </div>

        <div className={styles.formHalf}>
          <div className={styles.accessStack}>
            <div className={styles.card} data-state={state}>
              <span className={styles.tape} aria-hidden="true" />
              <p className={styles.eyebrow}>DemoBro private beta</p>
              <h1 id="beta-title">The camera crew is almost ready.</h1>
              <p className={styles.intro}>
                Enter today’s access key to test the one-shot micro demo studio.
              </p>

              <form onSubmit={submit} noValidate>
                <label className={styles.label} htmlFor="beta-access-key">
                  Access key
                </label>
                <input
                  id="beta-access-key"
                  className={styles.input}
                  type="password"
                  value={accessKey}
                  onChange={(event) => {
                    setAccessKey(event.target.value);
                    if (state === "error") {
                      setState("idle");
                      setMessage("Invited tester? Your key was included with your invitation.");
                    }
                  }}
                  autoComplete="current-password"
                  aria-invalid={state === "error"}
                  aria-describedby="beta-access-help"
                  disabled={state === "loading" || state === "success"}
                  placeholder="Today’s key"
                  autoFocus
                />
                <button
                  className={styles.button}
                  type="submit"
                  disabled={state === "loading" || state === "success"}
                  data-state={state}
                >
                  <span>{state === "loading" ? "Checking the list…" : state === "success" ? "Rolling camera…" : "Enter the studio"}</span>
                  <span className={styles.buttonMark} aria-hidden="true">▶</span>
                </button>
                <p
                  id="beta-access-help"
                  className={styles.helper}
                  role={state === "error" ? "alert" : "status"}
                >
                  {message}
                </p>
              </form>
            </div>

            <aside className={styles.eventTicket} aria-labelledby="hackyard-invite-title">
              <p className={styles.eventLabel}>HackYard · Event 01</p>
              <h2 id="hackyard-invite-title">No key? Join the first Yard.</h2>
              <p className={styles.eventCopy}>
                Full DemoBro access opens when HackYard’s first event goes live.
                Create your account, build a project, then make its demo from the
                submission page.
              </p>
              <a className={styles.eventLink} href="https://hackyard.tech/login">
                Create a HackYard account
                <span aria-hidden="true">→</span>
              </a>
            </aside>
          </div>
        </div>
      </section>
    </main>
  );
}
