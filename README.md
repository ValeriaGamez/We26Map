# Interactive WE26 Boston Map 

WEMap is an interactive conference floro map that help atendees plan their conference experience by finding exhibitors, organize company visits, and get walking directions to booths. 



https://github.com/user-attachments/assets/db23f01b-256f-4ec9-9162-67d83decbf28



I was at the SHPE conference having trouble finding booths even through there are official EXPOCAD floor maps. These aren't super interactive, and I wanted a more integrated tool where I could get directions to booths while inside the convention center but also, create a map of the places I wanted to visit and add notes for the people I connected with. I also wanted somewhere where I could do research on the exhibitors and what roles were open. 


### Features
- Users can search companies by name and booth number
- Navigate the floor map with zoom, drag controls
- Organize companies in routes, save them, mark them as visited
- Get directions to booths by placing a starting pin or using their live location
 
### Technical Highlights 
- The booth geometry is redered as an SVG foor plan and used D3 for pan and zoom 
- I got the booth coordinates with a script that fetches the original EXPOCAD floorplan's booth coordinates and exhibitor data, scales teh coordinates, and saves them in a structured JSON file for the interactive map. Each booth includes a list of (x, y) coordinates defining its shape. I got these points and converted them into polygons for my map and that way I kept the booths shape, size and position relative to others. 
- The most interesting part was figuring out a way to come up with directions, for every booth I wanted to go to, I wanted the shortest path. This took me bakc to when I took CSCI270 @USC, which I really enjoyed. I ended up making a walkable path by modeling the aisle intersections and booths as nodes, with edges representing walkable connections weighted by an estimated distance. 
- Then I used Dijktra's to find the shortest path through that network from a user selected or live location starting point to a booth. It was super rewarding translating an algorithm from class into an applied tool 
- I decided to go with browser local storage given the time I had to build the project, which was a little under 3 days. But it still preserves saved companies, visited status, nodes, routes, between sessions without requiring an account. There just isn't of course, sync across devices. 

### Stack 
- Built with Next.js, React, and TypeScript, using D3 for map pan and zoom and CSS Modules for component styling.

### Next steps
- I need another way of generating walkable paths automatically from booth geometry and open aisle space, reducing the need to manually place and connect routing nodes.
