{
  description = "browser — query and control browser tabs from the CLI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nix-crx.url = "github:andreivolt/nix-crx";
  };

  outputs = { self, nixpkgs, nix-crx }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];
    in {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};

          manifest = builtins.fromJSON (builtins.readFile ./extension/manifest.json);
          geckoId = manifest.browser_specific_settings.gecko.id;
          hostName = "com.browser_ext.host";

          # Rust native-messaging host: bridges CLI <-> extension.
          host = pkgs.rustPlatform.buildRustPackage {
            pname = "browser-ext-host";
            version = manifest.version;
            src = ./host;
            cargoLock.lockFile = ./host/Cargo.lock;
          };

          # Rust CLI: the `browser` command users run.
          cli = pkgs.rustPlatform.buildRustPackage {
            pname = "browser";
            version = manifest.version;
            src = ./cli;
            cargoLock.lockFile = ./cli/Cargo.lock;
          };

          # The WebExtension, plus a wrapped host binary that mirrors its
          # stderr into the journal for debugging.
          extension = pkgs.stdenv.mkDerivation {
            pname = "browser-ext-extension";
            version = manifest.version;
            src = ./extension;
            dontBuild = true;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            installPhase = ''
              mkdir -p $out/share/chromium-extension $out/bin
              cp -r * $out/share/chromium-extension/

              makeWrapper ${host}/bin/browser-ext-host $out/bin/browser-ext-host \
                --run 'exec 2> >(${pkgs.systemd}/bin/systemd-cat -t browser-ext)'
            '';
          };

          # Chrome: pack a signed CRX and an external-extension manifest so
          # the browser installs it persistently.
          crxPkg = nix-crx.lib.mkCrxPackage {
            inherit pkgs extension;
            key = ./keys/signing.pem;
            name = "browser-ext";
            version = manifest.version;
          };

          extDir = "share/mozilla/extensions/{ec8030f7-c20a-464f-9b0e-13a3a9e97384}";

          # Firefox: zip the extension into an unsigned XPI. sign-extension.sh
          # in the nixos-config repo signs this via AMO's unlisted channel.
          firefoxXpi = pkgs.stdenv.mkDerivation {
            pname = "browser-ext-firefox-xpi";
            version = manifest.version;
            dontUnpack = true;
            nativeBuildInputs = [ pkgs.zip ];
            buildPhase = ''
              cd ${extension}/share/chromium-extension
              zip -r $TMPDIR/extension.xpi .
            '';
            installPhase = ''
              mkdir -p $out/${extDir}
              cp $TMPDIR/extension.xpi $out/${extDir}/${geckoId}.xpi
            '';
          };

          # Native-messaging host registrations for both browsers.
          nativeMessaging = pkgs.linkFarm "browser-ext-native-messaging" [
            { name = "etc/chromium/native-messaging-hosts/${hostName}.json";
              path = pkgs.writeText "${hostName}.chrome.json" (builtins.toJSON {
                name = hostName;
                description = "browser-ext native messaging host";
                path = "${extension}/bin/browser-ext-host";
                type = "stdio";
                allowed_origins = [ "chrome-extension://${crxPkg.extId}/" ];
              });
            }
            { name = "lib/mozilla/native-messaging-hosts/${hostName}.json";
              path = pkgs.writeText "${hostName}.firefox.json" (builtins.toJSON {
                name = hostName;
                description = "browser-ext native messaging host";
                path = "${extension}/bin/browser-ext-host";
                type = "stdio";
                allowed_extensions = [ geckoId ];
              });
            }
          ];
        in {
          inherit host cli extension;

          # Default output: everything needed to install the extension on
          # Chrome and Firefox plus the `browser` CLI on PATH.
          default = pkgs.symlinkJoin {
            name = "browser-ext";
            paths = [
              extension
              cli
              crxPkg.package
              firefoxXpi
              nativeMessaging
            ];
          };
        }
      );

      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system}; in {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [ cargo rustc rust-analyzer web-ext ];
          };
        }
      );
    };
}
