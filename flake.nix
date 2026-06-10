{
  description = "browser — query and control browser tabs from the CLI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nix-webext.url = "github:rivavolt/nix-webext";
  };

  outputs = { self, nixpkgs, nix-webext }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];
    in {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};

          manifest = builtins.fromJSON (builtins.readFile ./extension/manifest.json);
          geckoId = manifest.browser_specific_settings.gecko.id;
          extId = "njgodecjaeinedgjbfbfjhggbapdofeb";
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

          # The WebExtension, plus a wrapped host binary that mirrors its stderr
          # into the journal for debugging.
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

          # Native-messaging host registrations for both browsers.
          nativeMessaging = pkgs.linkFarm "browser-ext-native-messaging" [
            { name = "etc/chromium/native-messaging-hosts/${hostName}.json";
              path = pkgs.writeText "${hostName}.chrome.json" (builtins.toJSON {
                name = hostName;
                description = "browser-ext native messaging host";
                path = "${extension}/bin/browser-ext-host";
                type = "stdio";
                allowed_origins = [ "chrome-extension://${extId}/" ];
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

          # Chrome CRX (signed at activation from sops) + Firefox XPI + the
          # `browser` CLI + native-messaging hosts, all folded into `default`. The
          # MV3 transform is on (the manifest carries both background forms).
          ext = nix-webext.lib.mkBrowserExtension {
            inherit pkgs extension extId geckoId;
            pname = "browser-ext";
            version = manifest.version;
            extraPaths = [ cli nativeMessaging ];
          };
        in {
          inherit host cli extension;
        } // ext);

      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system}; in {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [ cargo rustc rust-analyzer web-ext ];
          };
        }
      );
    };
}
