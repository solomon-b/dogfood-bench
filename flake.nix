{
  description = "Dogfood Bench: tracks how fast anthropics/claude-code fixes its issues";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            # `gh auth token` supplies the API token for the fetch script.
            pkgs.gh
            # `npm run serve` uses the Python static file server.
            pkgs.python3
            pkgs.nixpkgs-fmt
          ];
        };

        formatter = pkgs.nixpkgs-fmt;
      });
}
