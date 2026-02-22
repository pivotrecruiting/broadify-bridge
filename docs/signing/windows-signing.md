Stand: 19. Februar 2026.

## 1. Außerhalb vom Code: Azure Artifact Signing einrichten

1. In Azure Subscription den Provider registrieren: Microsoft.CodeSigning.
2. Einen Artifact Signing Account anlegen (Region + Endpoint merken, z. B. https://weu.codesigning.azure.net).
3. Identity Validation (Public) im Portal starten und abschließen (für kommerzielle Public-Verteilung Pflicht).
4. Danach ein Certificate Profile vom Typ Public Trust anlegen.
5. In Microsoft Entra eine App Registration erstellen.
6. Für die App Registration ein Client Secret erzeugen.
7. Der App Registration die Rolle Artifact Signing Certificate Profile Signer auf dem Certificate-Profile-Scope geben.

## 2. Im Repo: electron-builder konfigurieren

In electron-builder.json unter win ergänzen (du hast aktuell portable + msi in electron-builder.json:46):

```json
{
  "win": {
    "target": ["portable", "msi"],
    "icon": "./icon.png",
    "azureSignOptions": {
      "publisherName": "${env.AZURE_CODE_SIGNING_PUBLISHER_NAME}",
      "endpoint": "${env.AZURE_CODE_SIGNING_ENDPOINT}",
      "codeSigningAccountName": "${env.AZURE_CODE_SIGNING_ACCOUNT_NAME}",
      "certificateProfileName": "${env.AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME}",
      "TimestampRfc3161": "http://timestamp.acs.microsoft.com",
      "TimestampDigest": "SHA256"
    }
  }
}
```

## 3. CI/Build-Umgebung (Secrets)

Als GitHub-Secrets setzen und im Windows-Build-Job (`.github/workflows/release.yml`) als Env bereitstellen:

- AZURE_TENANT_ID
- AZURE_CLIENT_ID
- AZURE_CLIENT_SECRET
- AZURE_CODE_SIGNING_ENDPOINT
- AZURE_CODE_SIGNING_ACCOUNT_NAME
- AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME
- AZURE_CODE_SIGNING_PUBLISHER_NAME

## 4. Build ausführen (am besten Windows Runner)

1. Windows CI-Runner nutzen.
2. Build starten: npm ci dann npm run dist:win.
3. Ergebnis: signierte Artefakte in dist/ (.exe, .msi).

## 5. Signatur verifizieren (Pflicht)

Nach dem Build im CI:

```powershell
Get-ChildItem dist -Recurse -Include *.exe,*.msi | ForEach-Object {
  signtool verify /pa /v $_.FullName
}
```

## 6. Release-Best-Practices (kurz)

1. Immer alle Windows-Artefakte signieren (Installer + Helper-Binaries, falls separat verteilt).
2. Immer Timestamp setzen (sonst später ungültig, weil Signing-Zertifikate sehr kurz leben).
3. Publisher-Name konsistent halten.
4. Stable/Beta-Channels nutzen, aber Reputation nicht mit zu vielen unnötigen neuen Artefakten zerfasern.

Wenn du willst, schreibe ich dir jetzt direkt eine fertige Patch-Version für electron-builder.json plus einen verify:win-signatures Script-Eintrag in package.json.

Quellen:

- Microsoft Quickstart Artifact Signing: https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- Microsoft Signing Integrations (SignTool, Dlib, Timestamp): https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations
- Microsoft RBAC-Rollen Artifact Signing: https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles
- electron-builder Azure Trusted Signing: https://www.electron.build/code-signing-win.html
- electron-builder Windows config (azureSignOptions): https://www.electron.build/electron-builder.interface.windowsconfiguration
