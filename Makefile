build:
	electron-packager . once --out ../build_once --platform=win32 --arch=x64 --overwrite --icon "app/imgs/icons/mipmap-mdpi/ic_launcher.png" --ignore old --ignore once-win32-x64 --ignore \.gitignore --ignore Makefile --ignore .*\.7z --ignore ".*.zip" --ignore app --ignore old --ignore .once_db --ignore '.*\.txt' --ignore \.vscode --ignore \.once_db --prune

drun:
	LDEV=1 npm start

rip:
	LDEV=1 npm run re
