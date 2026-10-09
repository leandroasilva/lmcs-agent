# Configuração de Code Signing para macOS

Este documento explica como configurar a assinatura de código para o app macOS do LMCS Agent.

## Problema

Sem code signing válido, o macOS Gatekeeper bloqueia o app com a mensagem:

> "LMCS Code.app" está danificado e não pode ser aberto.

## Solução

### 1. Obter Certificados Apple Developer

Você precisa de uma conta Apple Developer ($99/ano) e os seguintes certificados:

1. **Developer ID Application Certificate** - para assinar o app
2. **Installer Certificate** - para assinar o installer (opcional para DMG)

### 2. Exportar o Certificado

1. Abra **Keychain Access** no macOS
2. Encontre seu certificado "Developer ID Application"
3. Clique com botão direito → **Exportar**
4. Salve como `.p12` com uma senha forte
5. Converta para base64:
   ```bash
   base64 -i seu-certificado.p12 -o cert-base64.txt
   ```

### 3. Configurar Secrets no GitHub

Adicione os seguintes secrets no repositório GitHub (Settings → Secrets and variables → Actions):

| Secret                        | Descrição                                                     |
| ----------------------------- | ------------------------------------------------------------- |
| `CSC_LINK`                    | Conteúdo do arquivo `cert-base64.txt` (certificado em base64) |
| `CSC_KEY_PASSWORD`            | Senha do certificado .p12                                     |
| `APPLE_ID`                    | Seu Apple ID (email)                                          |
| `APPLE_APP_SPECIFIC_PASSWORD` | Senha específica do app (gerada em appleid.apple.com)         |
| `APPLE_TEAM_ID`               | Team ID da sua conta Apple Developer (10 caracteres)          |

### 4. Gerar App-Specific Password

1. Acesse [appleid.apple.com](https://appleid.apple.com)
2. Faça login com seu Apple ID
3. Em "Sign-In and Security" → "App-Specific Passwords"
4. Clique em "Generate an app-specific password"
5. Use essa senha no secret `APPLE_APP_SPECIFIC_PASSWORD`

### 5. Notarização (Opcional mas Recomendado)

A notarização remove completamente o aviso do Gatekeeper. O electron-builder pode notarizar automaticamente quando as variáveis `APPLE_ID` e `APPLE_APP_SPECIFIC_PASSWORD` estão configuradas.

### 6. Verificar Configuração

Após configurar os secrets, o próximo deploy irá:

1. Assinar o app com seu certificado Developer ID
2. Notarizar o app com a Apple (se APPLE_ID configurado)
3. Publicar no GitHub Releases

Os usuários poderão instalar sem avisos de segurança.

## Desenvolvimento Local

Para testar localmente sem code signing:

```bash
# Remover quarentena do app baixado
xattr -cr /Applications/LMCS\ Code.app

# Ou desabilitar Gatekeeper temporariamente (não recomendado)
sudo spctl --master-disable
```

## Troubleshooting

### "App is damaged and can't be opened"

- Verifique se os secrets estão configurados corretamente
- Confirme que o certificado não expirou
- Tente remover a quarentena: `xattr -cr /Applications/LMCS Code.app`

### "No identity found"

- Verifique se `CSC_LINK` está em base64 válido
- Confirme que `CSC_KEY_PASSWORD` está correta

### "Team ID not found"

- Verifique seu Team ID em [developer.apple.com/account](https://developer.apple.com/account)
- Deve ter exatamente 10 caracteres

## Referências

- [Electron Builder Code Signing](https://www.electron.build/code-signing)
- [Apple Developer Certificates](https://developer.apple.com/support/code-signing/)
- [Notarizing macOS Software](https://developer.apple.com/documentation/xcode/notarizing_macos_software_before_distribution)
