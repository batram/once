build:
	electron-packager . once --platform=win32 --arch=x64 --overwrite --icon "app/imgs/icons/mipmap-mdpi/ic_launcher.png"

drun:
	LDEV=1 npm start
