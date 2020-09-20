default: build package
	echo "default build and package"

build:
	 npm run build

package:
	#DEBUG=electron-packager
	electron-packager . once --out ../build_once --platform=win32 --arch=x64 --overwrite --icon "dist/static/imgs/icons/mipmap-mdpi/ic_launcher.png" --prune --ignore="^/src" --ignore="/\..*" --ignore Makefile

drun:
	LDEV=1 npm start

stw:
	nodemon --watch "src/static/*" --exec "npm run copy_static" -e "*" 

rip:
	LDEV=1 npm run re
