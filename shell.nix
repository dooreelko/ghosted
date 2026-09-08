let
  pkgs = import <nixpkgs> { };

  moth = (builtins.getFlake "github:tailoredshapes/moth")
        .packages.${pkgs.system}.default;

in pkgs.mkShellNoCC {
 
    buildInputs = [
      
      pkgs.awscli2
	  pkgs.ssm-session-manager-plugin
	  pkgs.chromium
	  pkgs.nodejs_25
      pkgs.drawio
      pkgs.sqlite
      pkgs.opentofu

	  moth
   ];
 }


