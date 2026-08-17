let
  pkgs = import <nixpkgs> { };

moth = (builtins.getFlake "github:tailoredshapes/moth")
        .packages.${pkgs.system}.default;

in

pkgs.mkShellNoCC {

packages = with pkgs; [
	moth
    awscli2
	ssm-session-manager-plugin
 ];
   
}
