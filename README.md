# TxWiki

Open Source ando multi-space wiki

## Publicar una versión

Las versiones se publican al enviar una etiqueta con el formato
`vMAJOR.MINOR.PATCH-release`, por ejemplo `v1.1.1-release`:

```sh
git tag v1.1.1-release
git push origin v1.1.1-release
```

El workflow de GitHub Actions compila los recursos, ejecuta `npm audit`, todas
las pruebas unitarias y Playwright en sus navegadores configurados. Solo si
todas las comprobaciones pasan, crea y verifica un paquete ZIP firmado y lo
adjunta a un GitHub Release con el mismo nombre de la etiqueta, por ejemplo
`v1.1.1-release.zip`. El paquete conserva el formato firmado que acepta tanto
una instalación nueva como el actualizador integrado del sitio.

## Rotación de la clave de firma

La clave privada nunca se sube al repositorio. Para publicar, GitHub Actions usa
el secreto `UPDATE_SIGNING_KEY` y la variable de repositorio
`UPDATE_SIGNING_PUBLIC_KEY` (**Settings → Secrets and variables → Actions**).
La variable contiene solo la clave pública OpenSSH; el secreto contiene la
clave privada Ed25519 correspondiente.

La clave local anterior sí corresponde a la clave pública que ya confían los
sitios instalados. Por eso la rotación se realiza en dos etapas para no
interrumpir el actualizador integrado:

1. Añade `UPDATE_SIGNING_KEY` como **Repository secret**, pegando el contenido
   de la clave privada anterior `teralth-wiki-release-1.2.0.pem`.
2. Añade `UPDATE_SIGNING_PUBLIC_KEY` como **Repository variable** con la clave
   pública anterior:
   `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILracGvPgusw4mr22JdphtWs3jV6ZdmStphTPVovSkyG teralth-wiki-release`
3. Publica una etiqueta de versión después de incorporar este cambio. Esa
   primera versión puente se firma con la clave anterior y contiene la nueva
   clave pública. Los sitios ya instalados pueden verificarla y actualizar su
   confianza al instalarla.
4. Comprueba que la versión puente se publicó correctamente y que cada sitio
   existente la instaló antes de continuar.
5. Reemplaza el secreto `UPDATE_SIGNING_KEY` por el contenido del nuevo archivo
   privado local `teralth-wiki-release-2026-rotation.pem`. Actualiza la variable
   `UPDATE_SIGNING_PUBLIC_KEY` al nuevo valor:
   `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMufyNnb4Ph8wlqx4znDOF4RlbEFH1Aq4J3w7mj7WjlV teralth-wiki-release`
6. A partir de entonces, publica las etiquetas siguientes normalmente. Los
   nuevos paquetes se firman con la clave nueva. Conserva la clave privada
   anterior fuera del repositorio y no la vuelvas a usar para nuevas versiones.

No cambies al nuevo secreto antes de publicar la versión puente y permitir que
los sitios existentes la instalen: una instalación que aún confíe únicamente
en la clave anterior rechazará paquetes firmados con la nueva.
